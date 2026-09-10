package metrics

import "testing"

// Lua 已成功而后续消息失败时，准入事实必须保留，不能跟入队成功数混用。
func TestLuaAdmissionIsIndependentOfQueueAndRollback(t *testing.T) {
	ResetAll(300, 300)
	t.Cleanup(func() { ResetAll(300, 300) })
	RecordRedisPreDeduct(4)
	RecordInventoryRollback(4, "mq_send_failed")
	snapshot := SnapshotNow()
	if snapshot.LuaAdmissionSuccess != 1 || snapshot.QueueSuccess != 0 || snapshot.RedisStock != 300 {
		t.Fatalf("Lua admission lost or confused with queue success: %+v", snapshot)
	}
	RecordRedisPreDeduct(4)
	RecordCreateOrderEnqueued()
	RecordQueueSuccess(4)
	snapshot = SnapshotNow()
	if snapshot.LuaAdmissionSuccess != 2 || snapshot.QueueSuccess != 1 || snapshot.CreateOrderEnqueued != 1 {
		t.Fatalf("independent counters did not preserve both stages: %+v", snapshot)
	}
	ResetAll(300, 300)
	if got := SnapshotNow().LuaAdmissionSuccess; got != 0 {
		t.Fatalf("new round retained %d admissions", got)
	}
}

// 旧轮次消息确认消费，不能扣减当前轮次的延迟消息数量。
func TestOldRunDoesNotConsumeCurrentPending(t *testing.T) {
	previous := SeckillRunID()
	defer func() { SetSeckillRunID(previous); ResetAll(300, 300) }()
	SetSeckillRunID("current")
	ResetAll(300, 300)
	RecordMQEnqueued()
	RecordMQConsumed(true, "old")
	RecordMQConsumed(true)
	if got := SnapshotNow().MQPending; got != 1 {
		t.Fatalf("old messages changed pending to %d", got)
	}
	RecordMQConsumed(false, "current")
	if got := SnapshotNow().MQPending; got != 0 {
		t.Fatalf("current message pending=%d", got)
	}
}
