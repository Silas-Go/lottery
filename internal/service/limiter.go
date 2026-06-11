package service

import (
	"sync"
	"time"
)

type tokenBucketLimiter struct {
	rate       float64
	burst      float64
	tokens     float64
	lastRefill time.Time
	mu         sync.Mutex
}

func newTokenBucketLimiter(qps int) *tokenBucketLimiter {
	if qps <= 0 {
		return &tokenBucketLimiter{}
	}
	burst := float64(qps)
	return &tokenBucketLimiter{
		rate:       float64(qps),
		burst:      burst,
		tokens:     burst,
		lastRefill: time.Now(),
	}
}

func (l *tokenBucketLimiter) Allow() bool {
	if l == nil || l.rate <= 0 {
		return true
	}

	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	l.refill(now)
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

func (l *tokenBucketLimiter) refill(now time.Time) {
	if l.lastRefill.IsZero() {
		l.lastRefill = now
		l.tokens = l.burst
		return
	}
	elapsed := now.Sub(l.lastRefill).Seconds()
	if elapsed <= 0 {
		return
	}
	l.tokens += elapsed * l.rate
	if l.tokens > l.burst {
		l.tokens = l.burst
	}
	l.lastRefill = now
}
