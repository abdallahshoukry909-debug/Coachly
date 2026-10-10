import type { Metadata } from 'next'
import TerminalClient from './TerminalClient'

export const metadata: Metadata = {
  title: 'Market Terminal',
  description: 'Track markets and world events, with buy and exit signals',
}

export default function TerminalPage() {
  return <TerminalClient />
}
