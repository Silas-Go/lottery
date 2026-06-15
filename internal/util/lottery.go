package util

import (
	"math/rand/v2"
	"sort"
)

// Lottery 按权重返回被抽中的奖品下标。
// probs 是 probability weights 的缩写，在本项目里传入的是 Redis 剩余库存数量，
// 不需要提前归一化成百分比；库存越多，被选为候选奖品的概率越高。
// 返回值是 probs 的下标，不是 gift id，调用方需要再用 ids[index] 转成奖品 ID。
func Lottery(probs []float64) int {
	if len(probs) == 0 {
		return -1
	}
	sum := 0.0
	acc := make([]float64, 0, len(probs)) //累积概率
	for _, prob := range probs {
		sum += prob
		acc = append(acc, sum)
	}

	// 获取(0,sum] 随机数
	r := rand.Float64() * sum
	index := sort.SearchFloat64s(acc, r)
	return index
}
