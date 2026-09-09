import { mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.config";

export default mergeConfig(baseConfig, {
  test: {
    // The desktop suite runs memory-hard key derivation (scrypt) and live
    // BetterWright vault tests. On a shared, heavily concurrent host, they
    // can exceed the default 5s. Scoped here so apps/web and packages/*
    // keep the tighter default hang-detection window.
    testTimeout: 30_000,
  },
});
