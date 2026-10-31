import { readFileSync, writeFileSync } from 'node:fs'

const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_64_PRIME = 0x100000001b3n
const MAGIC = 0x43504600
const VERSION = 0x0001
const HEADER_SIZE = 32
const INDEX_ENTRY_SIZE = 16

export function fnv1a64(token) {
  let hash = FNV_64_OFFSET_BASIS
  for (let i = 0; i < token.length; i++) {
    hash ^= BigInt(token.charCodeAt(i))
    hash = (hash * FNV_64_PRIME) & 0xffffffffffffffffn
  }
  return hash
}

export class CpfWriter {
  constructor(outputPath) {
    this.outputPath = outputPath
    this.index = []
    this.dataBlocks = []
    this.totalDataSize = 0
  }

  addTokens(docId, tokens) {
    const seen = new Set()
    for (const token of tokens) {
      const hash = fnv1a64(token)
      const key = hash.toString()
      if (seen.has(key)) continue
      seen.add(key)
      this.index.push({ hash, docId, tf: 1 })
    }
  }

  finalize() {
    this.index.sort((a, b) => {
      if (a.hash < b.hash) return -1
      if (a.hash > b.hash) return 1
      const d = a.docId - b.docId
      if (d !== 0) return d
      return a.tf - b.tf
    })

    const merged = []
    let current = null
    for (const entry of this.index) {
      if (current && current.hash === entry.hash) {
        current.localIds.push(entry.docId)
        current.tfValues.push(entry.tf)
      } else {
        if (current) merged.push(current)
        current = { hash: entry.hash, localIds: [entry.docId], tfValues: [entry.tf] }
      }
    }
    if (current) merged.push(current)
    this.index = merged

    const headerBuf = Buffer.alloc(HEADER_SIZE)
    headerBuf.writeUInt32LE(MAGIC, 0)
    headerBuf.writeUInt32LE(VERSION, 4)
    headerBuf.writeUInt32LE(this.index.length, 8)
    headerBuf.writeUInt32LE(0, 12)
    headerBuf.writeBigUInt64LE(0n, 16)
    headerBuf.writeBigUInt64LE(0n, 24)

    const indexBuf = Buffer.alloc(this.index.length * INDEX_ENTRY_SIZE)
    const dataBufs = []
    let dataOffset = 0
    for (let i = 0; i < this.index.length; i++) {
      const entry = this.index[i]
      const block = encodeBlock(entry.localIds, entry.tfValues)
      dataBufs.push(block)
      indexBuf.writeBigUInt64LE(entry.hash, i * INDEX_ENTRY_SIZE)
      indexBuf.writeUInt32LE(dataOffset, i * INDEX_ENTRY_SIZE + 8)
      indexBuf.writeUInt32LE(block.length, i * INDEX_ENTRY_SIZE + 12)
      dataOffset += block.length
    }

    headerBuf.writeBigUInt64LE(BigInt(HEADER_SIZE + indexBuf.length), 16)

    const dataBuf = Buffer.concat(dataBufs)
    const full = Buffer.concat([headerBuf, indexBuf, dataBuf])

    writeFileSync(this.outputPath, full)
    return { numTokens: this.index.length, fileSize: full.length }
  }
}

function encodeBlock(localIds, tfValues) {
  const numDocs = localIds.length
  const useU16 = localIds.every(id => id <= 0xFFFF)
  const postingsLen = useU16 ? numDocs * 2 : numDocs * 4
  const buf = Buffer.alloc(8 + postingsLen + numDocs)
  buf.writeUInt32LE(numDocs, 0)
  buf.writeUInt32LE(postingsLen, 4)
  if (useU16) {
    for (let i = 0; i < numDocs; i++) buf.writeUInt16LE(localIds[i], 8 + i * 2)
  } else {
    for (let i = 0; i < numDocs; i++) buf.writeUInt32LE(localIds[i], 8 + i * 4)
  }
  for (let i = 0; i < numDocs; i++) buf[8 + postingsLen + i] = tfValues[i] ?? 1
  return buf
}

export class CpfIndex {
  constructor(path) {
    const data = readFileSync(path)
    this.data = data
    this.header = parseHeader(data)
    if (this.header.magic !== MAGIC) throw new Error(`Invalid CPF magic: 0x${this.header.magic.toString(16)}`)

    const numTokens = this.header.numTokens
    this.entries = []
    for (let i = 0; i < numTokens; i++) {
      const off = HEADER_SIZE + i * INDEX_ENTRY_SIZE
      this.entries.push({
        hash: data.readBigUInt64LE(off),
        offset: data.readUInt32LE(off + 8),
        length: data.readUInt32LE(off + 12),
      })
    }
  }

  lookup(token) {
    const hash = fnv1a64(token)
    let lo = 0, hi = this.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.entries[mid].hash < hash) lo = mid + 1
      else hi = mid
    }
    if (lo < this.entries.length && this.entries[lo].hash === hash) {
      return this.decodeBlock(lo)
    }
    return null
  }

  decodeBlock(idx) {
    const entry = this.entries[idx]
    const dataOff = Number(this.header.dataOffset) + entry.offset
    const buf = this.data
    const numDocs = buf.readUInt32LE(dataOff)
    const postingsLen = buf.readUInt32LE(dataOff + 4)
    const ids = []
    if (postingsLen === numDocs * 2) {
      for (let i = 0; i < numDocs; i++) ids.push(buf.readUInt16LE(dataOff + 8 + i * 2))
    } else {
      for (let i = 0; i < numDocs; i++) ids.push(buf.readUInt32LE(dataOff + 8 + i * 4))
    }
    const tfValues = []
    for (let i = 0; i < numDocs; i++) tfValues.push(buf[dataOff + 8 + postingsLen + i])
    return { docIds: ids, tfValues }
  }

  get numTokens() { return this.header.numTokens }
  get fileSize() { return this.data.length }
  get version() { return this.header.version }
}

function parseHeader(buf) {
  return {
    magic: buf.readUInt32LE(0),
    version: buf.readUInt32LE(4),
    numTokens: buf.readUInt32LE(8),
    reserved1: buf.readUInt32LE(12),
    dataOffset: buf.readBigUInt64LE(16),
    reserved2: buf.readBigUInt64LE(24),
  }
}
