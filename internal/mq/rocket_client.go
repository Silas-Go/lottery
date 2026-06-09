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

func genRocketClientID() string {
	idx := rocketClientSeq.Add(1) - 1
	nanotime := time.Now().UnixNano() / 1000
	return fmt.Sprintf("%s@%d@%d@%s", asciiHostName(), os.Getpid(), idx, strconv.FormatInt(nanotime, 36))
}

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
