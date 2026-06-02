package test

import (
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const url = "http://localhost:5678/lucky"
const P = 100 //模拟100个用户，在疯狂地点击“抽奖”

func TestLottery(t *testing.T) {
	hitMap := make(map[string]int, 10) //每个奖品被抽中的次数
	giftCh := make(chan string, 10000) //抽中的奖品id放入这个channel
	counterCh := make(chan struct{})   //判断异步协程是否结束

	//异步统计每个奖品被抽中的次数
	go func() {
		for giftId := range giftCh {
			hitMap[giftId]++
		}
		counterCh <- struct{}{} //异步协程结束
	}()

	wg := sync.WaitGroup{}
	wg.Add(P)
	begin := time.Now()
	var totalCall int64    //记录接口总调用次数
	var totalUseTime int64 //接口调用耗时总和
	for i := 0; i < P; i++ {
		go func() {
			defer wg.Done()
			for {
				t1 := time.Now()
				resp, err := http.Get(url)
				atomic.AddInt64(&totalUseTime, time.Since(t1).Milliseconds())
				atomic.AddInt64(&totalCall, 1) //调用次数加1
				if err != nil {
					fmt.Println(err)
					break
				}
				bs, err := io.ReadAll(resp.Body)
				if err != nil {
					fmt.Println(err)
					break
				}
				resp.Body.Close()
				giftId := string(bs)
				if len(giftId) > 0 {
					if giftId == "0" { //如果返回的奖品ID为0，说明已抽完
						break
					}
					giftCh <- giftId //抽中一个gift，就放入channel
				} else {
					fmt.Println("giftId为空")
				}
			}
		}()
	}
	wg.Wait()
	close(giftCh)
	<-counterCh //等hitMap准备好

	totalTime := int64(time.Since(begin).Seconds())
	if totalTime > 0 && totalCall > 0 {
		qps := totalCall / totalTime
		avgTime := totalUseTime / totalCall
		fmt.Printf("QPS %d, avg time %dms\n", qps, avgTime)
		//QPS 1650, avg time 69ms

		total := 0
		for giftId, count := range hitMap {
			fmt.Printf("%s\t%d\n", giftId, count)
			total += count
		}
		fmt.Printf("共计%d件商品\n", total)
	}
}

// go test -v ./lottery/handler/test -run=^TestLottery$ -count=1
