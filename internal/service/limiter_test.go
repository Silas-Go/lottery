package service

import (
	"testing"
	"time"
)

func TestTokenBucketLimiter(t *testing.T) {
	limiter := newTokenBucketLimiter(2)

	if !limiter.Allow() || !limiter.Allow() {
		t.Fatal("initial burst should allow two requests")
	}
	if limiter.Allow() {
		t.Fatal("empty bucket should reject request")
	}

	limiter.mu.Lock()
	limiter.lastRefill = time.Now().Add(-time.Second)
	limiter.mu.Unlock()

	if !limiter.Allow() {
		t.Fatal("bucket should refill after time passes")
	}
}

func TestTokenBucketLimiterDisabled(t *testing.T) {
	limiter := newTokenBucketLimiter(0)

	for i := 0; i < 10; i++ {
		if !limiter.Allow() {
			t.Fatal("disabled limiter should allow all requests")
		}
	}
}
