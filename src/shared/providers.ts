export interface ProviderInfo {
  protectedProfile?: boolean
  id: string
  name: string
  blurb: string
  comingSoon?: boolean
  installCommand: string
  signInCommand: string
  signInNote?: string
  signInInApp?: boolean
  unavailableNote?: string
  dataUse: DataUse
}

export interface DataUse {
  settingsUnverified?: boolean
  trainsByDefault: boolean
  what: string
  change: string
}

export interface AccountStatus {
  profile?: 'damon'
  state?: 'signed-in-subscription' | 'sign-in-required' | 'unsupported'
  detail?: string
  id: string
  installed: boolean
  loggedIn: boolean
  email?: string
  plan?: string
  comingSoon?: boolean
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'claude',
    name: 'Claude (Anthropic)',
    blurb: 'Powers the manager and Claude teammates. This is the one Damon needs to run.',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    signInCommand: 'claude auth login',
    signInNote: 'Opens your browser to sign in. Come back when it is done.',
    dataUse: {
      trainsByDefault: false,
      settingsUnverified: true,
      what: 'On personal Claude plans, work sent through Claude Code can be used for model improvement when that account setting is on. Damon has not checked your setting.',
      change: 'Check Claude Settings → Privacy and turn off model improvement before sending sensitive project data. This does not remove every provider retention requirement.'
    }
  },
  {
    id: 'openai',
    name: 'OpenAI (ChatGPT / Codex)',
    blurb: 'Run teammates on GPT models using your ChatGPT sign-in, through the Codex tool.',
    installCommand: 'npm install -g @openai/codex',
    signInCommand: 'codex login',
    signInNote: 'Opens your browser to sign in with ChatGPT.',
    dataUse: {
      trainsByDefault: true,
      settingsUnverified: true,
      what: 'On personal ChatGPT plans, Codex conversations may be used to improve models depending on your training setting. Damon has not checked your setting.',
      change: 'Check ChatGPT Settings → Data Controls and turn off "Improve the model for everyone" before sending sensitive project data. Local execution does not keep model requests on your device.'
    }
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    blurb: 'Run teammates on Gemini using your Google account, through the Gemini tool.',
    installCommand: 'npm install -g @google/gemini-cli',
    signInCommand: 'gemini',
    signInNote: 'Gemini has no sign-in command. Run it once and answer the questions it asks, then close it.',
    unavailableNote:
      'Google stopped letting personal accounts use this tool in June 2026, so it cannot run work for you even signed in. A paid Gemini key would bring it back. Nothing you can fix here.',
    dataUse: {
      trainsByDefault: true,
      what: 'On a personal Google account, Google collects the prompts, the answers and the code your teammates touch, and may use them to train its models. There is no switch for this on the free account.',
      change: 'A paid Gemini API key or a Google Workspace account stops it: on those, your work is not collected and not used for training. Fine as it is for throwaway work.'
    }
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot AI)',
    blurb: 'Run teammates on Kimi using your Kimi membership, through Moonshot’s own tool.',
    installCommand: 'npm install -g @moonshot-ai/kimi-code',
    signInCommand: 'kimi login --region global',
    signInInApp: true,
    signInNote:
      'Needs a live Kimi membership from kimi.ai. Signing in is refused without one, and kimi.com is a different service with separate billing.',
    unavailableNote:
      'Damon can sign you in, but it cannot run teammates on Kimi yet. That half is still being built, and it will not be switched on until it has been watched doing a real job.',
    dataUse: {
      trainsByDefault: true,
      what: 'Moonshot say what goes through their API is not used to train their models. The privacy policy you agree to allows it anyway, and there is no switch to turn it off on a personal plan. Your data may be held in Singapore.',
      change:
        'Nothing you can switch off. Only enterprise customers can negotiate it. Fine for ordinary work, worth avoiding for anything with real people’s details in it.'
    }
  }
]
