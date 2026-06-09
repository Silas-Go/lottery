package service

import (
	"sync"
	"time"
)

type fixedWindowLimiter struct {
	limit  int
	mu     sync.Mutex
	window int64
	count  int
}

func newFixedWindowLimiter(limit int) *fixedWindowLimiter {
	return &fixedWindowLimiter{limit: limit}
}

func (l *fixedWindowLimiter) Allow() bool {
	if l == nil || l.limit <= 0 {
		return true
	}

	now := time.Now().Unix()
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.window != now {
		l.window = now
		l.count = 0
	}
	if l.count >= l.limit {
		return false
	}
	l.count++
	return true
}
