package database

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"

	"github.com/go-redis/redis"
	"gorm.io/gorm"
)

// OrderIdentity 是一次资格的业务订单号及实验轮次；不使用会被实验重置的 MySQL 自增主键。
// 空标识只用于升级前的旧账本，绝不能匹配新资格。
type OrderIdentity struct {
	OrderID string `json:"order_id"`
	RunID   string `json:"run_id"`
}

// SeckillRunKey 持久保存当前实验轮次，普通重启不换轮；只有明确重置才更新。
const SeckillRunKey = "seckill:run_id"

var seckillRunGate sync.RWMutex

// BeginSeckillOperation 防止本进程重置在资格校验与账本写入之间插入。
// 这是现有单实例实验的重置屏障，不是跨实例分布式锁。
func BeginSeckillOperation() func() { seckillRunGate.RLock(); return seckillRunGate.RUnlock }

// BeginSeckillReset 排空正在处理的秒杀请求和消息；调用方必须覆盖库存、账本及指标的整个重置。
func BeginSeckillReset() func() { seckillRunGate.Lock(); return seckillRunGate.Unlock }

// NewIdentityID 生成不随清表或重启复用的 128 位随机业务标识。
func NewIdentityID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate order identity: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// CurrentSeckillRun 首次运行时原子建立轮次，随后读取同一持久值。
func CurrentSeckillRun() (string, error) {
	if GiftRedis == nil {
		return "", fmt.Errorf("redis client is nil")
	}
	run, err := GiftRedis.Get(SeckillRunKey).Result()
	if err == nil {
		return run, nil
	}
	if err != redis.Nil {
		return "", err
	}
	candidate, err := NewIdentityID()
	if err != nil {
		return "", err
	}
	if err = GiftRedis.SetNX(SeckillRunKey, candidate, 0).Err(); err != nil {
		return "", err
	}
	return GiftRedis.Get(SeckillRunKey).Result()
}

// RotateSeckillRun 只在持有重置屏障时调用；旧消息此后不能操作本轮资格。
func RotateSeckillRun() error {
	run, err := NewIdentityID()
	if err != nil {
		return err
	}
	if GiftRedis == nil {
		return fmt.Errorf("redis client is nil")
	}
	return GiftRedis.Set(SeckillRunKey, run, 0).Err()
}

func identityArg(ids []OrderIdentity) OrderIdentity {
	if len(ids) == 0 {
		return OrderIdentity{}
	}
	return ids[0]
}

// Valid 检查完整标识；分隔符不得进入 Redis 的序列化值。
func (id OrderIdentity) Valid() bool {
	return len(id.OrderID) == 32 && len(id.RunID) == 32 && !strings.ContainsAny(id.OrderID+id.RunID, "| \t\n")
}

// Identity 返回消息或账本绑定的业务标识。
func (o Order) Identity() OrderIdentity { return OrderIdentity{OrderID: o.OrderID, RunID: o.RunID} }

// Matches 要求用户定位到的资格仍属于同一次订单，旧格式只匹配双空标识。
func (a *LotteryAdmission) Matches(giftID int, id OrderIdentity) bool {
	return a != nil && a.GiftID == giftID && a.OrderID == id.OrderID && a.RunID == id.RunID
}

// FindOrderIdentity 新消息必须按业务订单号读取；旧账本只允许返回没有业务标识的记录。
func (s *Store) FindOrderIdentity(activityID, uid int, id OrderIdentity) (*Order, error) {
	if id.OrderID == "" && id.RunID == "" {
		order, err := s.FindOrder(activityID, uid)
		if err == nil && order.OrderID != "" {
			return nil, ErrOrderNotFound
		}
		return order, err
	}
	var order Order
	err := s.db.Where("order_id = ? AND run_id = ? AND activity_id = ? AND user_id = ?", id.OrderID, id.RunID, activityID, uid).First(&order).Error
	if err == gorm.ErrRecordNotFound {
		return nil, ErrOrderNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find order identity: %w", err)
	}
	return &order, nil
}
