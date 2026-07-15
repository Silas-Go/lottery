package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-redis/redis"
	"gorm.io/gorm"
)

const professionArchiveCachePrefix = "archive:profession:"

// ErrProfessionArchiveNotFound 让 service 能把“没有这一页”稳定映射成 404，
// 而不是依赖错误文本判断。
var ErrProfessionArchiveNotFound = errors.New("profession archive not found")

// ProfessionArchive 是《百职录》中的一页职业档案。
// MySQL 保存真本，Redis 只保存可丢弃的 JSON 副本；删掉缓存不会损失业务事实。
type ProfessionArchive struct {
	ID      int    `json:"id" gorm:"primaryKey"`
	Code    string `json:"code" gorm:"size:64;uniqueIndex"`
	Name    string `json:"name" gorm:"size:64"`
	Title   string `json:"title" gorm:"size:128"`
	Sigil   string `json:"sigil" gorm:"size:16"`
	Accent  string `json:"accent" gorm:"size:16"`
	Summary string `json:"summary" gorm:"size:600"`
	Oath    string `json:"oath" gorm:"size:255"`
}

func (ProfessionArchive) TableName() string { return "profession_archives" }

var defaultProfessionArchives = []ProfessionArchive{
	{ID: 1, Code: "night-warden", Name: "守夜人", Title: "替沉睡的城邦守住最后一盏灯", Sigil: "夜", Accent: "#315c78", Summary: "他们认识每一条在午夜改道的河，也听得见城墙深处极轻的裂响。守夜人的职责不是战胜黑暗，而是让所有人醒来时，仍相信黎明会如约而至。", Oath: "灯不必照亮远方，只要不在我手中熄灭。"},
	{ID: 2, Code: "clockwork-smith", Name: "机巧师", Title: "让沉默的铜与铁重新学会呼吸", Sigil: "械", Accent: "#9a6737", Summary: "机巧师的工作台从不真正安静。齿轮记得手指的温度，旧钟会在无人处低声报时，而每一件被世人判定报废的器物，都可能在他们掌心获得第二次心跳。", Oath: "世上没有废铁，只有尚未被听懂的请求。"},
	{ID: 3, Code: "star-reader", Name: "观星者", Title: "从群星的迟信里辨认尚未发生的风暴", Sigil: "星", Accent: "#6659a8", Summary: "他们在最高的塔上记录星辰，把几百年前启程的光译成今日的预兆。观星者并不预言命运；他们只是比旁人更早看见选择的代价。", Oath: "星辰从不回答，只把问题照得更清楚。"},
	{ID: 4, Code: "raven-physician", Name: "渡鸦医师", Title: "在瘟风经过之后替名字留住体温", Sigil: "鸦", Accent: "#48645a", Summary: "渡鸦医师随黑羽穿过封闭的城门。他们携带草药、银针和一本从不公开的姓名册：治愈一人便划去一个名字，未能归来的人，则由他们亲自送回故乡。", Oath: "疾病可以带走呼吸，不能带走一个人被记得的方式。"},
}

// EnsureProfessionArchiveSchema 为老数据卷补齐第一章所需的职业档案表。
// 使用运行期迁移是因为 Docker 的 init.sql 只会在新建数据卷时执行。
func (s *Store) EnsureProfessionArchiveSchema() error {
	if s == nil || s.db == nil {
		return errors.New("database store is nil")
	}
	if err := s.db.AutoMigrate(&ProfessionArchive{}); err != nil {
		return fmt.Errorf("migrate profession archives: %w", err)
	}
	for i := range defaultProfessionArchives {
		archive := defaultProfessionArchives[i]
		if err := s.db.Where("id = ?", archive.ID).FirstOrCreate(&archive).Error; err != nil {
			return fmt.Errorf("seed profession archive %d: %w", archive.ID, err)
		}
	}
	return nil
}

// ListProfessionArchives 读取百职录目录。
// 目录只在页面初始化时读取一次，不计入正文中的两组压力实验。
func (s *Store) ListProfessionArchives() ([]ProfessionArchive, error) {
	var archives []ProfessionArchive
	if err := s.db.Order("id ASC").Find(&archives).Error; err != nil {
		return nil, fmt.Errorf("list profession archives: %w", err)
	}
	return archives, nil
}

// GetProfessionArchive 从 MySQL 真本读取一页职业档案。
func (s *Store) GetProfessionArchive(id int) (*ProfessionArchive, error) {
	var archive ProfessionArchive
	if err := s.db.First(&archive, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: id=%d", ErrProfessionArchiveNotFound, id)
		}
		return nil, fmt.Errorf("read profession archive %d: %w", id, err)
	}
	return &archive, nil
}

func professionArchiveCacheKey(id int) string {
	return fmt.Sprintf("%s%d", professionArchiveCachePrefix, id)
}

// GetProfessionArchiveCache 按 Cache-Aside 规则读取 Redis 副本。
// hit=false 表示调用方必须回源 MySQL；Redis 不可用时上层也可以降级回源，缓存不能反客为主。
func GetProfessionArchiveCache(id int) (*ProfessionArchive, bool, error) {
	if GiftRedis == nil {
		return nil, false, errors.New("redis client is nil")
	}
	raw, err := GiftRedis.Get(professionArchiveCacheKey(id)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read profession archive cache %d: %w", id, err)
	}
	var archive ProfessionArchive
	if err := json.Unmarshal([]byte(raw), &archive); err != nil {
		_ = GiftRedis.Del(professionArchiveCacheKey(id)).Err()
		return nil, false, fmt.Errorf("decode profession archive cache %d: %w", id, err)
	}
	return &archive, true, nil
}

// SetProfessionArchiveCache 在 MySQL 回源成功后写入 Redis 副本。
// TTL 限制旧数据存活时间；未来若加入档案编辑，写路径还必须主动删除该 key。
func SetProfessionArchiveCache(archive *ProfessionArchive, ttl time.Duration) error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	raw, err := json.Marshal(archive)
	if err != nil {
		return fmt.Errorf("encode profession archive cache %d: %w", archive.ID, err)
	}
	if err := GiftRedis.Set(professionArchiveCacheKey(archive.ID), raw, ttl).Err(); err != nil {
		return fmt.Errorf("write profession archive cache %d: %w", archive.ID, err)
	}
	return nil
}

// ClearProfessionArchiveCache 清空第一章使用的缓存，保证冷启动实验可以重复。
func ClearProfessionArchiveCache() error {
	if GiftRedis == nil {
		return errors.New("redis client is nil")
	}
	return deleteRedisKeysByPattern(professionArchiveCachePrefix + "*")
}
