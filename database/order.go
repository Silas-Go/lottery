package database

import (
	"log/slog"
)

type Order struct {
	Id     int
	GiftId int
	UserId int
}

// 写入一条订单记录，返回订单ID
func CreateOrder(userid, giftid int) int {
	order := Order{GiftId: giftid, UserId: userid}
	if err := GiftDB.Create(&order).Error; err != nil {
		slog.Error("create order failed", "error", err, "userid", userid, "giftid", giftid)
		return 0
	} else {
		return order.Id
	}
}

// 清除全部订单记录
func ClearOrders() error {
	return GiftDB.Where("id>0").Delete(Order{}).Error
}
