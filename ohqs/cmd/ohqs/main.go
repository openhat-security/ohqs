package main

import (
	"fmt"
	"os"

	"github.com/openhat/quick-start/internal/cli"
)

func main() {
	if err := cli.New().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
