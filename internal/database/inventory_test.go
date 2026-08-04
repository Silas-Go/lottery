package database_test

import (
	"os"
	"silas/internal/database"
	"silas/internal/util"
	"strconv"
	"strings"
	"testing"
)

var (
	store                  *database.Store
	integrationConfigError string
)

func init() {
	// 这些测试会真实改写库存；默认测试套件不得连接开发中的项目数据。
	// 只有显式提供隔离 MySQL/Redis 并开启开关时才运行集成夹具。
	if os.Getenv("LOTTERY_INTEGRATION_TEST") != "1" {
		return
	}
	databaseName := strings.TrimSpace(os.Getenv("LOTTERY_MYSQL_DATABASE"))
	redisDB, redisErr := strconv.Atoi(strings.TrimSpace(os.Getenv("LOTTERY_REDIS_DB")))
	if databaseName == "" || databaseName == "lottery" || redisErr != nil || redisDB == 2 {
		integrationConfigError = "integration tests require an explicit non-lottery MySQL database and a Redis DB other than 2"
		return
	}
	util.InitSlog("../../log/lottery.log")
	store = database.ConnectGiftDB("../../conf", "mysql", util.YAML, "../../log/lottery.db.log")
	database.ConnectGiftRedis("../../conf", "redis", util.YAML)
}

func requireIntegrationStore(t *testing.T) {
	t.Helper()
	if integrationConfigError != "" {
		t.Fatal(integrationConfigError)
	}
	if store == nil {
		t.Skip("set LOTTERY_INTEGRATION_TEST=1 with isolated MySQL and Redis to run")
	}
}

func TestInitGiftInventory(t *testing.T) {
	requireIntegrationStore(t)
	if err := store.InitGiftInventory(); err != nil {
		t.Fatal(err)
	}
	gifts := database.GetAllGiftInventory()
	if len(gifts) != 1 || gifts[0].Id != database.StarMarrowMaterialID {
		t.Fatalf("inventory registry must contain only star marrow: %+v", gifts)
	}
}

func TestUpdateInventory(t *testing.T) {
	requireIntegrationStore(t)
	giftID := database.StarMarrowMaterialID
	c1 := database.GetGiftInventory(giftID)
	if c1 < 2 {
		t.Fatalf("star marrow test inventory too low: %d", c1)
	}
	if err := database.ReduceInventory(giftID); err != nil {
		t.Fatal(err)
	}
	if err := database.ReduceInventory(giftID); err != nil {
		_ = database.IncreaseInventory(giftID)
		t.Fatal(err)
	}
	c2 := database.GetGiftInventory(giftID)
	if err := database.IncreaseInventory(giftID); err != nil {
		t.Fatal(err)
	}
	if err := database.IncreaseInventory(giftID); err != nil {
		t.Fatal(err)
	}
	c3 := database.GetGiftInventory(giftID)
	if c1 != c3 {
		t.Fatalf("restored inventory=%d, want=%d", c3, c1)
	}
	if c1 != c2+2 {
		t.Fatalf("decremented inventory=%d, want=%d", c2, c1-2)
	}
}

// go test -v ./internal/database -run=^TestInitGiftInventory$ -count=1
// go test -v ./internal/database -run=^TestUpdateInventory$ -count=1
