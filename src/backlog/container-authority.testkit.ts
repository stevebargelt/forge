// FG-644: the SUBPROCESS half of the container-authority test seam.
//
// A spawned `forge` resolves its authority from the compiled-in mount, so a test that
// drives the CLI from inside an agent container reads THAT container's marker instead
// of its own fixture — and then asserts whatever the host happened to dispatch. There
// is no in-process setter to reach across a process boundary, so the child is given a
// preload instead: `node --import` this module with FORGE_TEST_AUTHORITY_MOUNT set.
//
// This does not weaken F2. The variable alone does nothing — nothing reads it unless
// the process was explicitly told to load this module — so an agent still cannot move
// the gate by setting an environment variable. Choosing what code your own process
// loads was never something the gate could prevent.

import { setAuthorityMountForTest } from "./container-authority.js";

const dir = process.env["FORGE_TEST_AUTHORITY_MOUNT"];
if (dir) setAuthorityMountForTest(dir);
