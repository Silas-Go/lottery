package main

import "silas/internal/app"

func main() {
	if err := app.New().Run(); err != nil {
		panic(err)
	}
}
