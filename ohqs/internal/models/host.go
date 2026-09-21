package models

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

// HostInfo describes the local compute budget for GGUF inference.
type HostInfo struct {
	RAMGB  float64 `json:"ramgb"`
	VRAMGB float64 `json:"vramgb"` // 0 when unknown (no discrete GPU reported)
	Label  string  `json:"label"`  // human description, e.g. "unified memory (Metal)" or "NVIDIA"
}

// Detect inspects the host: unified memory on macOS (Metal), total RAM plus
// nvidia-smi VRAM on Linux/Windows when a discrete GPU is present.
func Detect() HostInfo {
	ram := ramGB()
	h := HostInfo{RAMGB: ram}
	switch runtime.GOOS {
	case "darwin":
		h.VRAMGB = ram
		h.Label = "unified memory (Metal)"
	default:
		if vram := nvidiaVRAMGB(); vram > 0 {
			h.VRAMGB = vram
			h.Label = "NVIDIA VRAM"
		} else {
			h.Label = "system RAM (no discrete GPU reported)"
		}
	}
	if h.VRAMGB <= 0 && h.RAMGB <= 0 {
		h.RAMGB = 8
	}
	return h
}

// AvailableGB is the budget the fit check compares against: discrete VRAM when
// present, otherwise a realistic slice of system RAM (leave room for the OS and
// the embedding index).
func (h HostInfo) AvailableGB() float64 {
	if h.VRAMGB > 0 {
		return h.VRAMGB
	}
	if h.RAMGB > 0 {
		return h.RAMGB * 0.8
	}
	return 8
}

func ramGB() float64 {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
		if err != nil {
			return 0
		}
		n, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
		if err != nil {
			return 0
		}
		return float64(n) / (1024 * 1024 * 1024)
	case "linux":
		raw, err := os.ReadFile("/proc/meminfo")
		if err != nil {
			return 0
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if !strings.HasPrefix(line, "MemTotal:") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 2 {
				return 0
			}
			kb, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return 0
			}
			return float64(kb*1024) / (1024 * 1024 * 1024)
		}
	}
	return 0
}

func nvidiaVRAMGB() float64 {
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return 0
	}
	out, err := exec.Command("nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		mb, err := strconv.ParseFloat(strings.TrimSpace(line), 64)
		if err != nil || mb <= 0 {
			continue
		}
		return mb / 1024
	}
	return 0
}
