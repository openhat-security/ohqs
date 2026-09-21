package jobs

import (
	"fmt"
	"os"
	"os/exec"
	"time"
)

func (s *Store) Start(id string) error {
	m, err := s.Load(id)
	if err != nil {
		return err
	}
	if m.Status == StatusRunning && pidAlive(m.PID) {
		return nil
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, "job-worker", id)
	cmd.Dir = s.Root
	cmd.SysProcAttr = detachAttr()
	cmd.Env = append(os.Environ(), "OHQS_JOB="+id)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start worker: %w", err)
	}
	m.PID = cmd.Process.Pid
	m.Status = StatusRunning
	m.Error = ""
	if err := s.save(m); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func (s *Store) Stop(id string) error {
	m, err := s.Load(id)
	if err != nil {
		return err
	}
	if m.PID != 0 {
		_ = killProcess(m.PID)
	}
	m.Status = StatusStopped
	m.Error = "stopped"
	return s.save(m)
}

func (s *Store) Resume(id string) error {
	m, err := s.Load(id)
	if err != nil {
		return err
	}
	if m.Status == StatusDone {
		return fmt.Errorf("job already finished")
	}
	if m.Status == StatusRunning && pidAlive(m.PID) {
		return nil
	}
	s.AppendLog(id, "\n--- resume "+time.Now().UTC().Format(time.RFC3339)+" ---\n")
	m.Status = StatusQueued
	m.PID = 0
	m.Error = ""
	if err := s.save(m); err != nil {
		return err
	}
	return s.Start(id)
}
