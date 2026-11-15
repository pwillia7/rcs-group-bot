package main

import (
	"log"
	"os"
	"syscall"
)

// attachConsole reconnects stdout/stderr to the terminal that started us. A
// windowsgui exe gets no console of its own, so without this -login and manual
// runs would print nothing.
func attachConsole() {
	const attachParentProcess = ^uintptr(0) // (DWORD)-1
	r, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("AttachConsole").Call(attachParentProcess)
	if r == 0 {
		return // no parent console (e.g. double-clicked); nothing to print to
	}
	if out, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout, os.Stderr = out, out
		log.SetOutput(out)
	}
}
