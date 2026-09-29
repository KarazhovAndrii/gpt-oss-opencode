export function routes(app) {
  app.get("/health", (_req, res) => res.send("ok"));
  // TODO: add rate limiting to /login
  app.post("/login", login);
}

function login(req, res) {
  res.send("ok"); // TODO: validate the CSRF token
}
