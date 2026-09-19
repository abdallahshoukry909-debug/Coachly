import * as XLSX from 'xlsx'
import type { CallSection, SalesClient, SalesCall } from '@/lib/types'

const SECTION_LABEL: Record<CallSection, string> = {
  wema: 'Wema Sales (Machines)',
  silica: 'Silica Sales (Factory - East Pharma)',
}

const OUTCOME_LABEL: Record<SalesCall['outcome'], string> = {
  cold: 'Cold',
  warm: 'Warm',
  hot: 'Hot',
  no_answer: 'No Answer',
}

export function exportCallsToExcel(clients: SalesClient[], calls: SalesCall[]) {
  const workbook = XLSX.utils.book_new()

  const sections: CallSection[] = ['wema', 'silica']
  for (const section of sections) {
    const sectionClients = clients.filter((c) => c.section === section)
    const clientById = new Map(sectionClients.map((c) => [c.id, c]))

    const rows = calls
      .filter((call) => clientById.has(call.client_id))
      .map((call) => {
        const client = clientById.get(call.client_id)!
        return {
          'Client Name': client.name,
          'Client Number': client.phone ?? '',
          'Date Called': call.call_date,
          Status: OUTCOME_LABEL[call.outcome],
          Feedback: call.outcome === 'no_answer' ? (call.feedback ?? 'No answer') : (call.feedback ?? ''),
        }
      })

    // Include clients that have never been called yet, so nothing is lost in the backup.
    const calledClientIds = new Set(calls.map((c) => c.client_id))
    for (const client of sectionClients) {
      if (!calledClientIds.has(client.id)) {
        rows.push({
          'Client Name': client.name,
          'Client Number': client.phone ?? '',
          'Date Called': '',
          Status: 'Not called yet',
          Feedback: '',
        })
      }
    }

    const sheet = XLSX.utils.json_to_sheet(rows)
    sheet['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 48 }]
    XLSX.utils.book_append_sheet(workbook, sheet, SECTION_LABEL[section])
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  XLSX.writeFile(workbook, `call-tracker-backup-${timestamp}.xlsx`)
}
