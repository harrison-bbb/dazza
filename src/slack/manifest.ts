/**
 * Dazza's Slack app, as a manifest. Setup opens Slack's "create app" page with
 * this filled in, so the user doesn't have to pick scopes or events by hand.
 * Socket Mode means Slack sends events over a connection Dazza opens: no
 * public URL, nothing listening on the user's machine.
 */
export const SLACK_MANIFEST = {
  display_information: {
    name: 'Dazza',
    description: 'Your coding agent’s manager: reviews, blockers and progress from your terminal.',
    background_color: '#1c1c1c',
  },
  features: {
    app_home: {
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
    bot_user: { display_name: 'Dazza', always_online: false },
    slash_commands: [
      {
        command: '/dazza',
        description: 'Project status, or start or stop the build',
        usage_hint: 'status | build | stop',
        should_escape: false,
      },
    ],
  },
  oauth_config: {
    scopes: {
      bot: [
        // Post in the DM.
        'chat:write',
        // Read the user's messages in the DM.
        'im:history',
        // Screenshots.
        'files:write',
        // 👀 while Dazza is working out an answer.
        'reactions:write',
        // `/dazza`.
        'commands',
        // Look up the app's own id during setup, for links to its settings.
        'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ['message.im', 'app_home_opened'] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

/** Slack's "create app" page with the manifest filled in. */
export function createAppUrl(): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
    JSON.stringify(SLACK_MANIFEST),
  )}`;
}
