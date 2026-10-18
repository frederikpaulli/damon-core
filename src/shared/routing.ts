import { PROVIDERS } from './providers'
import { providerForModel } from './models'

export interface Handling {
  touchesPersonalData: boolean
  noTrainingProviders: boolean
}

export type Verdict =
  | { allow: true; warn?: undefined }
  | { allow: true; warn: string }
  | { allow: false; warn: string }

export function trainsOnYourWork(model: string): boolean {
  const id = providerForModel(model)
  return PROVIDERS.find((p) => p.id === id)?.dataUse.trainsByDefault === true
}

function nameOf(model: string): string {
  const id = providerForModel(model)
  return PROVIDERS.find((p) => p.id === id)?.name ?? id
}

export function checkRouting(model: string, handling: Handling): Verdict {
  if (!trainsOnYourWork(model)) return { allow: true }
  const who = nameOf(model)

  if (handling.noTrainingProviders) {
    return {
      allow: false,
      warn: `${who} uses what it is shown to train its own models, and this project is set to keep its work away from that. Put this on Claude instead, or change the setting for this project if you have decided the trade is fine.`
    }
  }

  if (handling.touchesPersonalData) {
    return {
      allow: true,
      warn: `This project handles real people's information, and ${who} may use what it is shown to train its own models. Their details would go with it. You can keep this project off those providers in the project settings.`
    }
  }

  return { allow: true }
}

export function allowedBrains<T extends { id: string }>(brains: T[], handling: Handling): T[] {
  if (!handling.noTrainingProviders) return brains
  return brains.filter((b) => !trainsOnYourWork(b.id))
}
