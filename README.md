# Crypto Fear & Greed for Gloom

Today's Crypto Fear and Greed Index (0 to 100) with its classification from Extreme Fear to Extreme Greed, yesterday, last week and last month, and a history chart with 30D, 90D, 1Y and All ranges. The chart is drawn in the five zone colours with the zone edges (25, 46, 54, 75) marked.

Index data from [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/). This plugin is not affiliated with or endorsed by Alternative.me.

## Install

Requires Gloom 0.15.0 or newer.

```sh
gloomberb install gloom-sh/gloom-fear-greed-crypto
```

Open `CFNG` in the command bar. (`FNG` is the stock-market Fear & Greed index that ships with Gloom.)

## Usage

`h`/`l` or the arrow keys switch the range. `o` opens the source, `r` refreshes. Click "Alternative.me" next to the value or the chart to open the source in the browser.

The pane shows a dial when it is tall enough for the dial and the chart, and a zone bar when it is not, so it stays usable at 90x30.

From the command line:

```sh
gloomberb fn CFNG                 # today, comparisons and 30 days of history
gloomberb fn CFNG --range 1Y      # 30D, 90D, 1Y or ALL
gloomberb fn CFNG --json
gloomberb shot CFNG --range 1Y --output cfng.png
```

## Data

[Alternative.me](https://alternative.me/crypto/fear-and-greed-index/) publishes the Crypto Fear and Greed Index. Its terms are on that page; this plugin follows them:

- The data is not used to impersonate Alternative.me or to build a service that could be confused with theirs. The plugin is a pane that shows their index, named for what it is, and it uses none of their branding.
- The source is credited right next to the data. The pane shows "Source: Alternative.me", linked to the page above, beside the index value and again beside the history chart. The command-line report carries the same credit.

Fetched directly from `api.alternative.me/fng/`, a free API with no key; nothing goes through Gloom Cloud. The index changes once a day, so the plugin does not poll:

- The first read takes the whole history (one request). After that it asks only for the days it is missing.
- The next read is scheduled from the `time_until_update` the API returns, shortly after 00:00 UTC. If the new day is late it looks again a few minutes later.
- The readings are kept between sessions, so the pane opens with data before anything is fetched. If a request fails, the last readings stay on screen marked stale and the retry backs off from five minutes to an hour.
- Pressing `r` more than once a minute does not make more than one request.

## Development

```sh
bun install
# Link a Gloom checkout, as the plugin installer does:
ln -s /path/to/gloomberb node_modules/gloomberb
ln -s /path/to/gloomberb/node_modules/react node_modules/react
bun run typecheck
bun test
```

`gloomberb` and `react` are peer dependencies, never real ones. Gloom symlinks its own copies into every plugin directory on install and on load, so there is exactly one instance of each in the process. CI links the host the same way.

The tests never reach the network. `fixtures/fng-latest-130.json` is the newest 130 days of a real response, and `fixtures/fng-label-samples.json` holds one real entry per value the API has published, which pins the classification boundaries to the API's own labels.

```sh
gloomberb plugin link .
gloomberb plugin doctor .
```

## License

MIT
