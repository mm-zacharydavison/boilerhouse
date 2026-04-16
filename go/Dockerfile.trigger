FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /trigger ./cmd/trigger/

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /trigger /trigger
USER 65532:65532
ENTRYPOINT ["/trigger"]
