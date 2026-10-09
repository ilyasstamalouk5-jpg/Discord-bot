# Voice Bot

Discord bot that tracks voice-chat time, gives milestone roles, and shows
profile / rank / leaderboard slash commands.

- Every voice channel counts, including AFK, muted, deafened, or alone.
- Time is saved continuously. A heartbeat is written about once a minute, so a
  crash or restart only loses the last minute or so.
- Database tables are created automatically when the bot starts.

## Environment variables

Set these in your host's "Environment variables" page. Never commit them.
See `.env.example` for the full list.

| Name | Required | What it is |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token from the Discord Developer Portal |
| `DATABASE_URL` | yes | Postgres connection string (for example from Neon) |
| `MILESTONE_GUILD_ID` | no | Server that has the milestone roles |
| `MILESTONE_ROLE_1` ... `MILESTONE_ROLE_10` | no | Role ID for each milestone |

Milestones are at 1h, 2h, 4h, 8h, 16h, 24h, 48h, 72h, 100h, 150h.

## Hosting notes

- Run exactly one copy of the bot. If your host offers a deploy strategy, pick
  "stop the old version before starting the new one" so two copies never run at
  the same time.
- The Discord Developer Portal needs the **Server Members Intent** turned on.
- The bot's role must be above the milestone roles in the server's role list,
  and it needs the **Manage Roles** permission.

## Commands (for developers)

```
pnpm install
pnpm test
pnpm start
```
