// @ts-check
import ssh2 from 'ssh2'
import { SuError } from './util.mjs'

export const KEYGEN_ATTEMPTS = 8

/**
 * ssh2 1.17 can trim an Ed25519 public key's leading zero along with the DER BIT STRING marker.
 * Validate generated pairs before using or persisting them; a malformed random draw must never reach SSH.
 * @param {{comment?: string}} [options]
 * @param {typeof ssh2.utils.generateKeyPairSync} [generate]
 */
export function generateEd25519(options = {}, generate = ssh2.utils.generateKeyPairSync) {
  for (let attempt = 0; attempt < KEYGEN_ATTEMPTS; attempt++) {
    const pair = generate('ed25519', options)
    const privateKey = ssh2.utils.parseKey(pair.private)
    const publicKey = ssh2.utils.parseKey(pair.public)
    if (!(privateKey instanceof Error) && !(publicKey instanceof Error)
      && privateKey.type === 'ssh-ed25519' && privateKey.isPrivateKey()
      && publicKey.type === 'ssh-ed25519' && !publicKey.isPrivateKey()
      && privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) return pair
  }
  // Do not attach malformed key material or parser inputs to the error.
  throw new SuError('INTERNAL', `could not generate a valid Ed25519 key pair after ${KEYGEN_ATTEMPTS} attempts`)
}
