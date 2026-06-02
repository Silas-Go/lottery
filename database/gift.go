package database

import (
	"log/slog"
)

const EMPTY_GIFT = 1 //空奖品（“谢谢参与”）的ID

type Gift struct {
	Id      int
	Name    string
	Price   int
	Picture string //图片存放路径
	Count   int    //库存量
}

func (Gift) TableName() string {
	return "inventory"
}

// 把inventory表里的数据全部取出来。当数量不多时可以直接select * from table
func GetAllGifts() []*Gift {
	var gifts []*Gift
	err := GiftDB.Select("*").Find(&gifts).Error
	if err != nil {
		slog.Error("scan table inventory failed", "error", err)
	}
	return gifts
}

func GetGift(id int) *Gift {
	gift := Gift{Id: id}
	err := GiftDB.Select("*").Find(&gift).Error
	if err != nil {
		slog.Error("get gift by id failed", "error", err, "gid", id)
		return nil
	}
	return &gift
}
