import { execFile } from 'node:child_process'

/** Un processus de ce nom d'image (« eden.exe ») tourne-t-il ? Faux si la recherche échoue (on ne bloque pas sur une incertitude de l'outil). */
export function processRunning(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(`"${image.toLowerCase()}"`))
    })
  })
}
