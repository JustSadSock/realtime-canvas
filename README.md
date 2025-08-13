## WebSocket proxying

If you run the signaling server behind Nginx or another reverse proxy,
make sure the WebSocket upgrade headers are forwarded. Example Nginx
snippet:

```nginx
location /signal {
  proxy_pass http://your_signal_upstream;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "Upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 86400;
  proxy_send_timeout 86400;
}
```

On HTTPS pages the client will always connect via `wss://`.

