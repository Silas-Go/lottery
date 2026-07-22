//go:build !linux

package loadtest

import "os/exec"

func configureProcess(_ *exec.Cmd) {}

func terminateProcess(command *exec.Cmd) {
	if command != nil && command.Process != nil {
		_ = command.Process.Kill()
	}
}
