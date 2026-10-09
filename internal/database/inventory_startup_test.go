package database

import (
	"errors"
	"testing"

	"github.com/go-redis/redis"
)

// 启动检查只能读取库存；缺失、售罄和损坏不能混成同一种状态。
func TestValidateGiftInventory(t *testing.T) {
	for _, tc := range []struct {
		name    string
		ids     []string
		stock   string
		readErr error
		want    int64
		wantErr bool
	}{
		{name: "preserve depleted inventory", ids: []string{"4"}, stock: "99", want: 99},
		{name: "sold out is initialized", ids: []string{"4"}, stock: "0"},
		{name: "missing registry", wantErr: true},
		{name: "wrong registry", ids: []string{"3"}, stock: "1000", wantErr: true},
		{name: "extra registry entry", ids: []string{"4", "3"}, stock: "1000", wantErr: true},
		{name: "missing stock is not sold out", ids: []string{"4"}, readErr: redis.Nil, wantErr: true},
		{name: "redis unavailable", ids: []string{"4"}, readErr: errors.New("connection unavailable"), wantErr: true},
		{name: "corrupt stock", ids: []string{"4"}, stock: "invalid", wantErr: true},
		{name: "negative stock", ids: []string{"4"}, stock: "-1", wantErr: true},
		{name: "stock above baseline", ids: []string{"4"}, stock: "1001", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := redis.NewClient(&redis.Options{})
			defer client.Close()
			previous := GiftRedis
			GiftRedis = client
			defer func() { GiftRedis = previous }()
			client.WrapProcess(func(_ func(redis.Cmder) error) func(redis.Cmder) error {
				return func(cmd redis.Cmder) error {
					switch cmd.Name() {
					case "smembers":
						if cmd.Args()[1] != INVENTORY_IDS_KEY {
							t.Fatalf("unexpected registry read: %v", cmd.Args())
						}
						*cmd.(*redis.StringSliceCmd) = *redis.NewStringSliceResult(tc.ids, nil)
					case "get":
						if cmd.Args()[1] != "gift_count_4" {
							t.Fatalf("unexpected stock read: %v", cmd.Args())
						}
						*cmd.(*redis.StringCmd) = *redis.NewStringResult(tc.stock, tc.readErr)
					default:
						t.Fatalf("startup must not write Redis: %v", cmd.Args())
					}
					return cmd.Err()
				}
			})
			// 三次实例启动检查都只能观察现有值，不能恢复到 MySQL 的 1000。
			for i := 0; i < 3; i++ {
				got, err := ValidateGiftInventory([]*Gift{{Id: 4, Count: 1000}})
				if (err != nil) != tc.wantErr || got != tc.want {
					t.Fatalf("check %d: total=%d err=%v, want total=%d error=%v", i, got, err, tc.want, tc.wantErr)
				}
			}
		})
	}
}
