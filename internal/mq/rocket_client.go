package mq

import (
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unsafe"

	rmq_client "github.com/apache/rocketmq-clients/golang/v5"
)

var rocketClientSeq atomic.Int64

// newRocketClient 创建带安全 clientID 的 RocketMQ client。
// RocketMQ Go v5 默认 client id 会使用 os.Hostname()，中文电脑名会进入 gRPC header，
// gRPC header 只允许可打印 ASCII 字符，最终导致客户端启动失败。
func newRocketClient(config *rmq_client.Config, opts ...rmq_client.ClientOption) (rmq_client.Client, error) {
	client, err := rmq_client.NewClient(config, opts...)
	if err != nil {
		return nil, err
	}
	if err := setRocketClientID(client, genRocketClientID()); err != nil {
		return nil, err
	}
	return client, nil
}

// genRocketClientID 生成 RocketMQ client id。
// client id 的业务语义是“当前进程中的 MQ 客户端唯一标识”，格式保持 hostname@pid@seq@time，
// 但 hostname 会先转成 ASCII，避免中文主机名触发 gRPC header 非 ASCII 错误。
func genRocketClientID() string {
	idx := rocketClientSeq.Add(1) - 1
	nanotime := time.Now().UnixNano() / 1000
	return fmt.Sprintf("%s@%d@%d@%s", asciiHostName(), os.Getpid(), idx, strconv.FormatInt(nanotime, 36))
}

// asciiHostName 把操作系统主机名转换成 RocketMQ/gRPC 可接受的 ASCII 字符串。
// 非英文字符会被折叠成短横线；如果最终为空，则回退到 localhost。
func asciiHostName() string {
	host, err := os.Hostname()
	if err != nil {
		return "localhost"
	}

	var b strings.Builder
	lastDash := false
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			b.WriteRune(r)
			lastDash = false
		default:
			if b.Len() > 0 && !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}

	value := strings.Trim(b.String(), "-")
	if value == "" {
		return "localhost"
	}
	return value
}

// setRocketClientID 通过反射写入 RocketMQ SDK 内部 clientID 字段。
// 这是对 RocketMQ Go v5 中文主机名问题的兼容补丁；如果未来 SDK 暴露正式配置项，
// 应优先改用官方 API，避免继续依赖私有字段结构。
func setRocketClientID(client rmq_client.Client, clientID string) error {
	value := reflect.ValueOf(client)
	if value.Kind() != reflect.Ptr || value.IsNil() {
		return fmt.Errorf("rocketmq client must be a pointer, got %T", client)
	}

	field := value.Elem().FieldByName("clientID")
	if !field.IsValid() || field.Kind() != reflect.String || !field.CanAddr() {
		return fmt.Errorf("rocketmq client does not expose an addressable clientID field")
	}

	reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem().SetString(clientID)
	return nil
}
