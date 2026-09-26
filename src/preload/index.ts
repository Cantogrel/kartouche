import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { RomVaultApi } from '@shared/ipc'

const api: RomVaultApi = {
  invoke: (channel, req) => ipcRenderer.invoke(channel, req),
  on: (event, cb) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l = (_e: unknown, payload: any): void => cb(payload)
    ipcRenderer.on(event, l)
    return () => { ipcRenderer.removeListener(event, l) }
  },
  pathOf: (file) => webUtils.getPathForFile(file),
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    fullscreen: (on) => ipcRenderer.send('win:fullscreen', on)
  }
}
contextBridge.exposeInMainWorld('api', api)
