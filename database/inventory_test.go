package database_test

import (
	"dqq/go/frame/lottery/database"
	"dqq/go/frame/lottery/util"
	"fmt"
	"testing"

	"github.com/gofiber/fiber/v3/log"
)

func init() {
	util.InitSlog("../../log/lottery.log")
	database.ConnectGiftDB("../conf", "mysql", util.YAML, "../../log/lottery.db.log")
	database.ConnectGiftRedis("../conf", "redis", util.YAML)
}

func TestInitGiftInventory(t *testing.T) {
	database.InitGiftInventory()
	for _, gift := range database.GetAllGiftInventory() {
		fmt.Printf("%d %d\n", gift.Id, gift.Count)
	}
}

func TestUpdateInventory(t *testing.T) {
	GiftId := 1
	c1 := database.GetGiftInventory(GiftId)
	database.ReduceInventory(GiftId)
	database.ReduceInventory(GiftId)
	c2 := database.GetGiftInventory(GiftId)
	database.IncreaseInventory(GiftId)
	database.IncreaseInventory(GiftId)
	c3 := database.GetGiftInventory(GiftId)
	if c1 != c3 {
		log.Errorf("c1=%d, c3=%d", c1, c3)
	}
	if c1 != c2+2 {
		log.Errorf("c1=%d, c2=%d", c1, c2)
	}
}

// go test -v ./lottery/database -run=^TestInitGiftInventory$ -count=1
// go test -v ./lottery/database -run=^TestUpdateInventory$ -count=1
