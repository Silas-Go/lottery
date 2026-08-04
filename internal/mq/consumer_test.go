package mq

import (
	"encoding/json"
	"errors"
	"silas/internal/database"
	"strings"
	"testing"
	"time"
)

func resetConsumerEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"LOTTERY_MQ_CONSUMER_GROUP",
		"LOTTERY_MQ_ORDER_CONSUMER_GROUP",
		"LOTTERY_MQ_PURCHASE_CACHE_CONSUMER_GROUP",
		"LOTTERY_MQ_TOPIC",
		"LOTTERY_MQ_ORDER_TOPIC",
		"LOTTERY_MQ_CANCEL_TOPIC",
		"LOTTERY_MQ_PURCHASE_INVALIDATION_TOPIC",
	} {
		t.Setenv(key, "")
	}
}

func TestConsumerConfigurationSeparatesResponsibilities(t *testing.T) {
	resetConsumerEnv(t)
	if err := ValidateConsumerConfig(); err != nil {
		t.Fatalf("default consumer configuration should be valid: %v", err)
	}
	if OrderConsumerGroup() != "lottery" {
		t.Fatalf("order group changed existing offset identity: %q", OrderConsumerGroup())
	}
	if PurchaseCacheConsumerGroup() != "lottery-purchase-cache" {
		t.Fatalf("unexpected purchase cache group: %q", PurchaseCacheConsumerGroup())
	}
	if OrderConsumerGroup() == PurchaseCacheConsumerGroup() {
		t.Fatal("different subscriptions must not share one consumer group")
	}

	orderSubscriptions := orderConsumerSubscriptions()
	if len(orderSubscriptions) != 2 || orderSubscriptions[OrderTopic()] == nil || orderSubscriptions[CancelTopic()] == nil {
		t.Fatalf("order consumer subscriptions are not isolated: %#v", orderSubscriptions)
	}
	purchaseSubscriptions := purchaseCacheConsumerSubscriptions()
	if len(purchaseSubscriptions) != 1 || purchaseSubscriptions[PurchaseInvalidationTopic()] == nil {
		t.Fatalf("purchase cache consumer subscriptions are not isolated: %#v", purchaseSubscriptions)
	}
	if orderConsumerAwaitDuration != 5*time.Second || purchaseConsumerAwaitDuration != 5*time.Second {
		t.Fatalf("unexpected await durations: order=%s purchase=%s",
			orderConsumerAwaitDuration, purchaseConsumerAwaitDuration)
	}
}

func TestConsumerConfigurationRejectsSharedGroupAndTopic(t *testing.T) {
	t.Run("shared group", func(t *testing.T) {
		resetConsumerEnv(t)
		t.Setenv("LOTTERY_MQ_ORDER_CONSUMER_GROUP", "same-group")
		t.Setenv("LOTTERY_MQ_PURCHASE_CACHE_CONSUMER_GROUP", "same-group")
		if err := ValidateConsumerConfig(); err == nil || !strings.Contains(err.Error(), "must differ") {
			t.Fatalf("shared group should be rejected, got %v", err)
		}
	})

	t.Run("shared topic", func(t *testing.T) {
		resetConsumerEnv(t)
		t.Setenv("LOTTERY_MQ_CANCEL_TOPIC", "CREATE_ORDER")
		if err := ValidateConsumerConfig(); err == nil || !strings.Contains(err.Error(), "must differ") {
			t.Fatalf("shared topic should be rejected, got %v", err)
		}
	})
}

func TestLegacyOrderConsumerGroupFallback(t *testing.T) {
	resetConsumerEnv(t)
	t.Setenv("LOTTERY_MQ_CONSUMER_GROUP", "legacy-orders")
	if got := OrderConsumerGroup(); got != "legacy-orders" {
		t.Fatalf("legacy order group fallback lost: %q", got)
	}
	t.Setenv("LOTTERY_MQ_ORDER_CONSUMER_GROUP", "explicit-orders")
	if got := OrderConsumerGroup(); got != "explicit-orders" {
		t.Fatalf("explicit order group should win: %q", got)
	}
}

func TestOrderConsumerRoutesOnlyOrderLifecycleTopics(t *testing.T) {
	resetConsumerEnv(t)
	order := database.Order{UserId: 7, GiftId: 9}
	body, err := json.Marshal(order)
	if err != nil {
		t.Fatal(err)
	}

	createCalled := false
	rolledBack, err := handleOrderMessage(OrderTopic(), "create-1", body,
		func(command database.Order) error {
			createCalled = command.UserId == order.UserId && command.GiftId == order.GiftId
			return nil
		}, nil)
	if err != nil || rolledBack || !createCalled {
		t.Fatalf("create message routed incorrectly: rollback=%v called=%v err=%v", rolledBack, createCalled, err)
	}

	timeoutCalled := false
	rolledBack, err = handleOrderMessage(CancelTopic(), "cancel-1", body, nil,
		func(command database.Order) (bool, error) {
			timeoutCalled = command.UserId == order.UserId
			return true, nil
		})
	if err != nil || !rolledBack || !timeoutCalled {
		t.Fatalf("cancel message routed incorrectly: rollback=%v called=%v err=%v", rolledBack, timeoutCalled, err)
	}

	if _, err := handleOrderMessage(PurchaseInvalidationTopic(), "wrong-topic", body, nil, nil); err == nil {
		t.Fatal("order consumer must reject purchase cache topic")
	}
	if _, err := handleOrderMessage(OrderTopic(), "bad-json", []byte("{"), nil, nil); err == nil {
		t.Fatal("malformed order message must remain unhandled")
	}
}

func TestPurchaseCacheConsumerRoutesOnlyInvalidationTopic(t *testing.T) {
	resetConsumerEnv(t)
	command := database.PurchaseCacheInvalidation{EventID: "event-1", MaterialID: 4}
	body, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}

	called := false
	decoded, err := handlePurchaseCacheMessage(PurchaseInvalidationTopic(), "cache-1", body,
		func(actual database.PurchaseCacheInvalidation) error {
			called = actual == command
			return nil
		})
	if err != nil || !called || decoded != command {
		t.Fatalf("cache invalidation routed incorrectly: decoded=%+v called=%v err=%v", decoded, called, err)
	}

	if _, err := handlePurchaseCacheMessage(OrderTopic(), "wrong-topic", body, nil); err == nil {
		t.Fatal("purchase cache consumer must reject order topic")
	}
	if _, err := handlePurchaseCacheMessage(PurchaseInvalidationTopic(), "handler-error", body,
		func(database.PurchaseCacheInvalidation) error { return errors.New("delete failed") }); err == nil {
		t.Fatal("handler failure must leave the message unhandled")
	}
}
