package handler

import (
	"dqq/go/frame/lottery/database"
	"dqq/go/frame/lottery/mq"
	"dqq/go/frame/lottery/util"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

const (
	PAY_DELAY = 600 //用户必须在PAY_DELAY秒之内完成支付，否则视为放弃
)

// 获取所有奖品信息，用于初始化轮盘
func GetAllGifts(ctx *gin.Context) {
	gifts := database.GetAllGifts()
	if len(gifts) == 0 {
		ctx.JSON(http.StatusInternalServerError, nil)
	} else {
		//抹掉敏感信息
		for _, gift := range gifts {
			gift.Count = 1
		}
		ctx.JSON(http.StatusOK, gifts)
	}
}

// 抽奖
func Lottery(ctx *gin.Context) {
	for try := 0; try < 10; try++ { //最多重试10次
		gifts := database.GetAllGiftInventory() //获取所有奖品剩余的库存量
		ids := make([]int, 0, len(gifts))
		probs := make([]float64, 0, len(gifts))
		for _, gift := range gifts {
			if gift.Count > 0 { //先确保redis返回的库存量大小0，因为抽奖算法Lottery不支持抽中概率为0的奖品
				ids = append(ids, gift.Id)
				probs = append(probs, float64(gift.Count))
			}
		}
		if len(ids) == 0 {
			ctx.String(http.StatusOK, strconv.Itoa(0)) //0表示所有奖品已抽完
			return
		}
		index := util.Lottery(probs) //抽中第index个奖品
		giftId := ids[index]
		err := database.ReduceInventory(giftId) // 先从redis上减库存
		if err != nil {
			slog.Error("已无库存，减库存失败", "奖品ID", giftId) //设想，某奖品只剩1件，并发情况下多个协程恰好都抽中了该奖品，第一个协程减库存后为0，第一个协程减库存后为负数--即减库存失败，即本次抽奖失败，进入下一轮for循环重试
			continue                                 //减库存失败，则重试
		} else {
			uid := 1 //没做登录系统，把用户id写死为1
			inst := database.GetGift(giftId)
			if inst == nil {
				slog.Error("找不到奖品", "gid", giftId)
				continue
			}
			database.CreateTempOrder(uid, giftId)                                      //创建临时订单
			mq.SendCancelOrder(database.Order{UserId: uid, GiftId: giftId}, PAY_DELAY) //发送延迟消息，通知下游删除临时订单
			slog.Info("抽中奖品", "用户", uid, "奖品", giftId)

			// 先设置Cookie
			ctx.SetCookie("name", inst.Name, PAY_DELAY, "/", "localhost", false, false)                 //抢中的商品名称
			ctx.SetCookie("price", strconv.Itoa(inst.Price), PAY_DELAY, "/", "localhost", false, false) //商品价格
			ctx.SetCookie("uid", strconv.Itoa(uid), PAY_DELAY, "/", "localhost", false, false)          //用户id
			ctx.SetCookie("gid", strconv.Itoa(giftId), PAY_DELAY, "/", "localhost", false, false)       //商品id

			// 再设置body
			ctx.String(http.StatusOK, strconv.Itoa(giftId)) //减库存成功后才给前端返回奖品ID

			return
		}
	}
	ctx.String(http.StatusOK, strconv.Itoa(database.EMPTY_GIFT)) //如果10次之后还失败，则返回“谢谢参与”
}
