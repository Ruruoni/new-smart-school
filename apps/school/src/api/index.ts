import { createRouter } from "./router";
import { authRoutes } from "./routes/auth";
import { platformRoutes } from "./routes/platform";
import { academicsRoutes } from "./routes/academics";
import { peopleRoutes } from "./routes/people";
import { resultsRoutes } from "./routes/results";
import { financeRoutes } from "./routes/finance";
import { admissionsRoutes } from "./routes/admissions";
import { operationsRoutes } from "./routes/operations";
import { cbtRoutes } from "./routes/cbt";
import { serviceRoutes } from "./routes/services";

/** Every HTTP endpoint of the school installation. Each protected route declares its guard, so the security
 *  interceptor (auth → installation → license → module → feature → RBAC → policies) runs on all of them. */
export const routes = [...authRoutes, ...platformRoutes, ...academicsRoutes, ...peopleRoutes, ...resultsRoutes, ...financeRoutes, ...admissionsRoutes, ...operationsRoutes, ...cbtRoutes, ...serviceRoutes];
export const handle = createRouter(routes);
