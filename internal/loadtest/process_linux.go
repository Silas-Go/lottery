//go:build linux

package loadtest

import (
	"os/exec"
	"syscall"
	"time"
)

// configureProcess 让 wrk2 成为独立进程组，停止任务时不会遗留它未来可能派生的子进程。
func configureProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcess(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
	time.Sleep(150 * time.Millisecond)
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
}
