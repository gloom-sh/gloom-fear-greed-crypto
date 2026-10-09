import { act, useMemo, useReducer } from "react";
import {
  AppContext,
  PaneFooterBar,
  PaneFooterProvider,
  PaneInstanceProvider,
  PluginRenderProvider,
  appReducer,
  createInitialState,
  createStatefulTestPluginRuntime,
  createTestPaneConfig,
  testRender,
} from "gloomberb/test-support";
import { Box } from "gloomberb/ui";
import { setHttpFetchTransport } from "gloomberb/utils";
import { resetFngClient } from "./client";
import { CryptoFearGreedPane } from "./pane";
import { CRYPTO_FEAR_GREED_PANE_ID, CRYPTO_FEAR_GREED_PLUGIN_ID } from "./types";

export const TEST_PANE_ID = `${CRYPTO_FEAR_GREED_PANE_ID}:main`;

/** The pane the way the app draws it: provider stack, pane body, footer bar. */
export function PaneHarness({ width, height, focused = true }: { width: number; height: number; focused?: boolean }) {
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const initial = createInitialState(createTestPaneConfig("/tmp/gloomberb-crypto-fear-greed-test", {
      instanceId: TEST_PANE_ID,
      paneId: CRYPTO_FEAR_GREED_PANE_ID,
      binding: { kind: "none" },
      settings: {},
    }));
    initial.focusedPaneId = TEST_PANE_ID;
    return initial;
  });
  return (
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PluginRenderProvider pluginId={CRYPTO_FEAR_GREED_PLUGIN_ID} runtime={runtime}>
          <PaneFooterProvider>
            {(footer) => (
              <Box flexDirection="column" width={width} height={height}>
                <CryptoFearGreedPane
                  paneId={TEST_PANE_ID}
                  paneType={CRYPTO_FEAR_GREED_PANE_ID}
                  focused={focused}
                  width={width}
                  height={height - 1}
                />
                <PaneFooterBar footer={footer} focused={focused} width={width} />
              </Box>
            )}
          </PaneFooterProvider>
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

export async function settle(setup: Awaited<ReturnType<typeof testRender>>, frames = 6): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await setup.renderOnce();
    });
  }
}

/**
 * Serves the API from the test: `respond` answers every request, the URLs asked
 * for are recorded, and `restore` puts the real transport back and ends any
 * request still waiting (the client shares one in-flight request per URL, so a
 * request left hanging would hold the next test's).
 */
export function serveApi(respond: (limit: number) => Response | Promise<Response>): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const waiting = new Set<(error: Error) => void>();
  resetFngClient();
  setHttpFetchTransport((url) => {
    urls.push(url);
    const limit = Number(new URL(url).searchParams.get("limit") ?? "0");
    return new Promise<Response>((resolve, reject) => {
      waiting.add(reject);
      Promise.resolve(respond(limit)).then(resolve, reject);
    });
  });
  return {
    urls,
    restore: () => {
      setHttpFetchTransport(null);
      for (const reject of waiting) reject(new Error("The test ended."));
      waiting.clear();
      resetFngClient();
    },
  };
}
