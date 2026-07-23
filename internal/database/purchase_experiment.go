package database

import (
	"errors"
	"fmt"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	PurchaseLabOrderCommitted = "committed"

	PurchaseOutboxPending    = "pending"
	PurchaseOutboxPublishing = "publishing"
	PurchaseOutboxRetry      = "retry"
	PurchaseOutboxPublished  = "published"
	PurchaseOutboxCompleted  = "completed"
	PurchaseOutboxCancelled  = "cancelled"
)

var (
	// ErrPurchaseRequestConflict 表示同一 request_id 被用于不同材料、数量或方案。
	// 相同请求的完全重试会返回原订单；参数变化则拒绝，避免幂等键被误复用。
	ErrPurchaseRequestConflict  = errors.New("purchase request id conflicts with existing order")
	errPurchaseRequestDuplicate = errors.New("purchase request duplicated during commit")
)

// PurchaseLabOrder 是购买实验的最小订单账本。
// request_id 是幂等边界；库存扣减和订单插入位于同一 MySQL 事务。
type PurchaseLabOrder struct {
	ID                uint64    `json:"id" gorm:"primaryKey;autoIncrement"`
	BatchID           string    `json:"batchId" gorm:"size:96;not null;index:idx_purchase_lab_batch"`
	RequestID         string    `json:"requestId" gorm:"size:128;not null;uniqueIndex:uk_purchase_lab_request"`
	MaterialID        int       `json:"materialId" gorm:"not null;index:idx_purchase_lab_material"`
	Quantity          int       `json:"quantity" gorm:"not null"`
	Strategy          string    `json:"strategy" gorm:"size:40;not null"`
	Status            string    `json:"status" gorm:"size:24;not null"`
	PurchaseLatencyMS float64   `json:"purchaseLatencyMs" gorm:"type:decimal(12,3);not null;default:0"`
	CreatedAt         time.Time `json:"createdAt" gorm:"autoCreateTime"`
}

func (PurchaseLabOrder) TableName() string { return "purchase_lab_orders" }

// PurchaseLabOutbox 与订单、库存扣减在同一事务提交。
// publishing 状态在进程崩溃后会恢复为 retry；消息可能重复发送，因此消费者必须幂等。
type PurchaseLabOutbox struct {
	ID            uint64     `json:"id" gorm:"primaryKey;autoIncrement"`
	BatchID       string     `json:"batchId" gorm:"size:96;not null;index:idx_purchase_outbox_batch"`
	EventID       string     `json:"eventId" gorm:"size:160;not null;uniqueIndex:uk_purchase_outbox_event"`
	RequestID     string     `json:"requestId" gorm:"size:128;not null;uniqueIndex:uk_purchase_outbox_request"`
	MaterialID    int        `json:"materialId" gorm:"not null;index:idx_purchase_outbox_material"`
	Status        string     `json:"status" gorm:"size:24;not null;index:idx_purchase_outbox_status"`
	RetryCount    int        `json:"retryCount" gorm:"not null;default:0"`
	LastError     string     `json:"lastError,omitempty" gorm:"size:500;not null;default:''"`
	NextRetryAt   *time.Time `json:"nextRetryAt,omitempty"`
	CreatedAt     time.Time  `json:"createdAt" gorm:"autoCreateTime"`
	PublishedAt   *time.Time `json:"publishedAt,omitempty"`
	InvalidatedAt *time.Time `json:"invalidatedAt,omitempty"`
}

func (PurchaseLabOutbox) TableName() string { return "purchase_lab_outbox" }

// PurchaseCacheInvalidation 是 RocketMQ 中唯一允许的材料缓存失效消息。
// Consumer 只接受 event_id/material_id，不能携带任意 Redis key 或命令。
type PurchaseCacheInvalidation struct {
	EventID    string `json:"eventId"`
	MaterialID int    `json:"materialId"`
}

// PurchaseExperimentState 同时展示 MySQL 权威库存和现有材料详情 DTO 中的缓存库存。
type PurchaseExperimentState struct {
	MaterialID   int  `json:"materialId"`
	InitialStock int  `json:"initialStock"`
	MySQLStock   int  `json:"mysqlStock"`
	RedisStock   *int `json:"redisStock"`
}

// PurchaseCommitResult 是单个购买请求的事务结果。
type PurchaseCommitResult struct {
	Order     *PurchaseLabOrder
	Outbox    *PurchaseLabOutbox
	Duplicate bool
	SoldOut   bool
}

// EnsurePurchaseExperimentSchema 为老数据卷补齐订单和 Outbox 表。
func (s *Store) EnsurePurchaseExperimentSchema() error {
	if s == nil || s.db == nil {
		return errors.New("database store is nil")
	}
	if err := s.db.AutoMigrate(&PurchaseLabOrder{}, &PurchaseLabOutbox{}); err != nil {
		return fmt.Errorf("migrate purchase experiment schema: %w", err)
	}
	return nil
}

// ResetPurchaseExperimentMaterial 将 materials.stock 恢复到目录夹具基线。
// 未完成的 Outbox 先标记 cancelled，使已经在 MQ 中的迟到消息不再删除新预热缓存。
// Redis 预热在 service 层、事务提交后执行，因为 Redis 不属于 MySQL 事务。
func (s *Store) ResetPurchaseExperimentMaterial(materialID int) (int, error) {
	initialStock, ok := initialMaterialStock(materialID)
	if !ok {
		return 0, fmt.Errorf("%w: id=%d", ErrMaterialArchiveNotFound, materialID)
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		// 先锁定材料行，避免“库存本来就是基线值”时 MySQL 返回 0 changed rows
		// 被误判为材料不存在，也避免重置和购买事务同时改写同一份权威库存。
		var material MaterialCatalog
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Select("id", "stock").First(&material, "id = ?", materialID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("%w: id=%d", ErrMaterialArchiveNotFound, materialID)
			}
			return err
		}
		if err := tx.Model(&MaterialCatalog{}).
			Where("id = ?", materialID).
			UpdateColumn("stock", initialStock).Error; err != nil {
			return err
		}
		if err := tx.Model(&PurchaseLabOutbox{}).
			Where("material_id = ? AND status NOT IN ?", materialID,
				[]string{PurchaseOutboxCompleted, PurchaseOutboxCancelled}).
			Updates(map[string]any{"status": PurchaseOutboxCancelled, "last_error": "experiment reset"}).Error; err != nil {
			return err
		}
		if err := tx.Where("material_id = ?", materialID).Delete(&PurchaseLabOrder{}).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("reset purchase experiment material %d: %w", materialID, err)
	}
	return initialStock, nil
}

// InspectPurchaseExperimentState 使用与 /api/archives/:id/cached 相同的 DTO key。
func (s *Store) InspectPurchaseExperimentState(materialID int) (*PurchaseExperimentState, error) {
	stock, err := s.MaterialStock(materialID)
	if err != nil {
		return nil, err
	}
	initialStock, ok := initialMaterialStock(materialID)
	if !ok {
		return nil, fmt.Errorf("%w: id=%d", ErrMaterialArchiveNotFound, materialID)
	}
	detail, hit, err := GetMaterialDetailCache(materialID)
	if err != nil {
		return nil, err
	}
	var redisStock *int
	if hit && detail != nil {
		value := detail.Stock
		redisStock = &value
	}
	return &PurchaseExperimentState{
		MaterialID: materialID, InitialStock: initialStock,
		MySQLStock: stock, RedisStock: redisStock,
	}, nil
}

// MaterialStock 返回 materials.stock 权威库存。
func (s *Store) MaterialStock(materialID int) (int, error) {
	var material MaterialCatalog
	if err := s.db.Select("id", "stock").First(&material, "id = ?", materialID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, fmt.Errorf("%w: id=%d", ErrMaterialArchiveNotFound, materialID)
		}
		return 0, fmt.Errorf("read material stock %d: %w", materialID, err)
	}
	return material.Stock, nil
}

// CommitMaterialPurchase 原子完成条件扣库存、幂等订单和可选 Outbox 写入。
// 唯一键竞争发生时整个事务回滚，再读取先提交的订单，因此不会重复扣库存。
func (s *Store) CommitMaterialPurchase(
	batchID, requestID, eventID string,
	materialID, quantity int,
	strategy string,
	withOutbox bool,
) (*PurchaseCommitResult, error) {
	if batchID == "" || requestID == "" || materialID <= 0 || quantity <= 0 || strategy == "" {
		return nil, errors.New("invalid material purchase transaction input")
	}
	if withOutbox && eventID == "" {
		return nil, errors.New("purchase outbox event id is required")
	}
	result := &PurchaseCommitResult{}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		var existing PurchaseLabOrder
		findErr := tx.Where("request_id = ?", requestID).First(&existing).Error
		if findErr == nil {
			if existing.BatchID != batchID || existing.MaterialID != materialID ||
				existing.Quantity != quantity || existing.Strategy != strategy {
				return ErrPurchaseRequestConflict
			}
			result.Order = &existing
			result.Duplicate = true
			if withOutbox {
				var outbox PurchaseLabOutbox
				if err := tx.Where("request_id = ?", requestID).First(&outbox).Error; err != nil {
					return err
				}
				result.Outbox = &outbox
			}
			return nil
		}
		if !errors.Is(findErr, gorm.ErrRecordNotFound) {
			return findErr
		}

		stock := tx.Exec(
			"UPDATE materials SET stock = stock - ? WHERE id = ? AND stock >= ?",
			quantity, materialID, quantity,
		)
		if stock.Error != nil {
			return stock.Error
		}
		if stock.RowsAffected == 0 {
			var count int64
			if err := tx.Model(&MaterialCatalog{}).Where("id = ?", materialID).Count(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				return fmt.Errorf("%w: id=%d", ErrMaterialArchiveNotFound, materialID)
			}
			result.SoldOut = true
			return nil
		}

		order := &PurchaseLabOrder{
			BatchID: batchID, RequestID: requestID, MaterialID: materialID,
			Quantity: quantity, Strategy: strategy, Status: PurchaseLabOrderCommitted,
		}
		if err := tx.Create(order).Error; err != nil {
			if isMySQLDuplicate(err) {
				return errPurchaseRequestDuplicate
			}
			return err
		}
		result.Order = order

		if withOutbox {
			outbox := &PurchaseLabOutbox{
				BatchID: batchID, EventID: eventID, RequestID: requestID,
				MaterialID: materialID, Status: PurchaseOutboxPending,
			}
			if err := tx.Create(outbox).Error; err != nil {
				return err
			}
			result.Outbox = outbox
		}
		return nil
	})
	if errors.Is(err, errPurchaseRequestDuplicate) {
		var existing PurchaseLabOrder
		if findErr := s.db.Where("request_id = ?", requestID).First(&existing).Error; findErr != nil {
			return nil, fmt.Errorf("read duplicate purchase request %s: %w", requestID, findErr)
		}
		if existing.BatchID != batchID || existing.MaterialID != materialID ||
			existing.Quantity != quantity || existing.Strategy != strategy {
			return nil, ErrPurchaseRequestConflict
		}
		result = &PurchaseCommitResult{Order: &existing, Duplicate: true}
		if withOutbox {
			var outbox PurchaseLabOutbox
			if findErr := s.db.Where("request_id = ?", requestID).First(&outbox).Error; findErr != nil {
				return nil, fmt.Errorf("read duplicate purchase outbox %s: %w", requestID, findErr)
			}
			result.Outbox = &outbox
		}
		err = nil
	}
	if err != nil {
		return nil, fmt.Errorf("commit material purchase %s: %w", requestID, err)
	}
	return result, nil
}

// UpdatePurchaseOrderLatency 只补充观测值，不参与库存和订单原子性。
func (s *Store) UpdatePurchaseOrderLatency(requestID string, latencyMS float64) error {
	if err := s.db.Model(&PurchaseLabOrder{}).
		Where("request_id = ?", requestID).
		UpdateColumn("purchase_latency_ms", latencyMS).Error; err != nil {
		return fmt.Errorf("update purchase latency %s: %w", requestID, err)
	}
	return nil
}

// RecoverPurchaseOutbox 将发布中断点恢复为可重试状态。
// 如果消息已经发出但状态尚未写回，恢复后会重复发送；Consumer 的幂等 DEL 负责兜底。
func (s *Store) RecoverPurchaseOutbox() error {
	if err := s.db.Model(&PurchaseLabOutbox{}).
		Where("status = ?", PurchaseOutboxPublishing).
		Updates(map[string]any{
			"status":        PurchaseOutboxRetry,
			"last_error":    "publisher restarted before status confirmation",
			"next_retry_at": time.Now(),
			"retry_count":   gorm.Expr("retry_count + 1"),
		}).Error; err != nil {
		return fmt.Errorf("recover purchase outbox: %w", err)
	}
	return nil
}

// ClaimNextPurchaseOutbox 使用行锁认领一个事件，支持多实例 Worker 而不重复并发发布。
func (s *Store) ClaimNextPurchaseOutbox(now time.Time) (*PurchaseLabOutbox, error) {
	var claimed *PurchaseLabOutbox
	err := s.db.Transaction(func(tx *gorm.DB) error {
		var event PurchaseLabOutbox
		err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status IN ? AND (next_retry_at IS NULL OR next_retry_at <= ?)",
				[]string{PurchaseOutboxPending, PurchaseOutboxRetry}, now).
			Order("id").
			First(&event).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		updated := tx.Model(&PurchaseLabOutbox{}).
			Where("id = ? AND status IN ?", event.ID,
				[]string{PurchaseOutboxPending, PurchaseOutboxRetry}).
			Updates(map[string]any{"status": PurchaseOutboxPublishing, "last_error": ""})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return nil
		}
		event.Status = PurchaseOutboxPublishing
		claimed = &event
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("claim purchase outbox: %w", err)
	}
	return claimed, nil
}

func (s *Store) MarkPurchaseOutboxPublished(eventID string, publishedAt time.Time) error {
	if err := s.db.Model(&PurchaseLabOutbox{}).
		Where("event_id = ? AND status = ?", eventID, PurchaseOutboxPublishing).
		Updates(map[string]any{
			"status":        PurchaseOutboxPublished,
			"published_at":  publishedAt,
			"next_retry_at": nil,
			"last_error":    "",
		}).Error; err != nil {
		return fmt.Errorf("mark purchase outbox published %s: %w", eventID, err)
	}
	return nil
}

func (s *Store) MarkPurchaseOutboxPublishFailed(eventID string, retryAt time.Time, cause error) error {
	message := ""
	if cause != nil {
		message = cause.Error()
	}
	if err := s.db.Model(&PurchaseLabOutbox{}).
		Where("event_id = ? AND status = ?", eventID, PurchaseOutboxPublishing).
		Updates(map[string]any{
			"status":        PurchaseOutboxRetry,
			"retry_count":   gorm.Expr("retry_count + 1"),
			"next_retry_at": retryAt,
			"last_error":    message,
		}).Error; err != nil {
		return fmt.Errorf("mark purchase outbox retry %s: %w", eventID, err)
	}
	return nil
}

// MarkPurchaseOutboxInvalidated 是 Consumer 的幂等完成动作。
// completed/cancelled 重复消息不会改变结果，避免 MQ 重投污染事件状态。
func (s *Store) MarkPurchaseOutboxInvalidated(eventID string, invalidatedAt time.Time) error {
	if err := s.db.Model(&PurchaseLabOutbox{}).
		Where("event_id = ? AND status NOT IN ?",
			eventID, []string{PurchaseOutboxCompleted, PurchaseOutboxCancelled}).
		Updates(map[string]any{
			"status":         PurchaseOutboxCompleted,
			"published_at":   gorm.Expr("COALESCE(published_at, ?)", invalidatedAt),
			"invalidated_at": invalidatedAt,
			"last_error":     "",
		}).Error; err != nil {
		return fmt.Errorf("mark purchase outbox completed %s: %w", eventID, err)
	}
	return nil
}

func (s *Store) RecordPurchaseOutboxConsumerFailure(eventID string, cause error) error {
	message := ""
	if cause != nil {
		message = cause.Error()
	}
	if err := s.db.Model(&PurchaseLabOutbox{}).
		Where("event_id = ? AND status NOT IN ?",
			eventID, []string{PurchaseOutboxCompleted, PurchaseOutboxCancelled}).
		Updates(map[string]any{
			"retry_count": gorm.Expr("retry_count + 1"),
			"last_error":  message,
		}).Error; err != nil {
		return fmt.Errorf("record purchase consumer failure %s: %w", eventID, err)
	}
	return nil
}

func (s *Store) PurchaseOutboxByEvent(eventID string) (*PurchaseLabOutbox, error) {
	var event PurchaseLabOutbox
	if err := s.db.Where("event_id = ?", eventID).First(&event).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("read purchase outbox %s: %w", eventID, err)
	}
	return &event, nil
}

func (s *Store) PurchaseBatchRecords(batchID string) ([]PurchaseLabOrder, []PurchaseLabOutbox, error) {
	var orders []PurchaseLabOrder
	if err := s.db.Where("batch_id = ?", batchID).Order("id").Find(&orders).Error; err != nil {
		return nil, nil, fmt.Errorf("read purchase batch orders %s: %w", batchID, err)
	}
	var events []PurchaseLabOutbox
	if err := s.db.Where("batch_id = ?", batchID).Order("id").Find(&events).Error; err != nil {
		return nil, nil, fmt.Errorf("read purchase batch outbox %s: %w", batchID, err)
	}
	return orders, events, nil
}

func initialMaterialStock(materialID int) (int, bool) {
	for _, material := range defaultMaterialCatalog {
		if material.ID == materialID {
			return material.Stock, true
		}
	}
	return 0, false
}

func isMySQLDuplicate(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}
