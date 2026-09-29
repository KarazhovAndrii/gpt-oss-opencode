import { routes } from "./api/routes.js";
import { connect } from "./db/pool.js";

connect();
routes({ get() {}, post() {} });
// TODO: graceful shutdown on SIGTERM
