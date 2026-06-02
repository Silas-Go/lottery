package database

import (
	"fmt"
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
	gifts, _ := GetAllGiftsWithError()
	return gifts
}

func GetAllGiftsWithError() ([]*Gift, error) {
	var gifts []*Gift
	err := GiftDB.Select("*").Find(&gifts).Error
	if err != nil {
		slog.Error("scan table inventory failed", "error", err)
		return nil, fmt.Errorf("scan inventory table: %w", err)
	}
	return gifts, nil
}

func GetGift(id int) *Gift {
	gift, _ := GetGiftWithError(id)
	return gift
}

func GetGiftWithError(id int) (*Gift, error) {
	gift := Gift{Id: id}
	err := GiftDB.Select("*").Find(&gift).Error
	if err != nil {
		slog.Error("get gift by id failed", "error", err, "gid", id)
		return nil, fmt.Errorf("get gift by id %d: %w", id, err)
	}
	if gift.Id == 0 {
		err := fmt.Errorf("gift %d not found", id)
		slog.Error("get gift by id failed", "error", err, "gid", id)
		return nil, err
	}
	return &gift, nil
}
