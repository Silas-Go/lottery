FROM golang:1.25-alpine AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/lottery .

FROM alpine:3.22

WORKDIR /app

RUN addgroup -S lottery && adduser -S lottery -G lottery

COPY --from=builder /out/lottery /app/lottery
COPY conf /app/conf
COPY views /app/views
COPY init.sql /app/init.sql

RUN mkdir -p /app/log && chown -R lottery:lottery /app

USER lottery

EXPOSE 5678

CMD ["/app/lottery"]
