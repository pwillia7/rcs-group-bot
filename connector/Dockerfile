FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /gm-connector .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /gm-connector /gm-connector
ENV LOG_JSON=1 HTTP_ADDR=127.0.0.1:8081
ENTRYPOINT ["/gm-connector"]
CMD ["serve"]
