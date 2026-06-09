package database_test

import (
	"silas/internal/database"
	"testing"
)

func TestCreateTempOrder(t *testing.T) {
	uid := 1
	gid := 1
	err := database.CreateTempOrder(uid, gid)
	if err != nil {
		t.Error(err)
		return
	}
	if database.GetTempOrder(uid) != gid {
		t.Fail()
		return
	}
}

func TestDeleteTempOrder(t *testing.T) {
	uid := 1
	gid := 1
	err := database.CreateTempOrder(uid, gid)
	if err != nil {
		t.Error(err)
		return
	}
	if database.GetTempOrder(uid) != gid {
		t.Fail()
		return
	}

	database.DeleteTempOrder(uid, gid)
	if database.GetTempOrder(uid) > 0 {
		t.Fail()
	}
}

// go test -v ./internal/database -run=^TestCreateTempOrder$ -count=1
// go test -v ./internal/database -run=^TestDeleteTempOrder$ -count=1
