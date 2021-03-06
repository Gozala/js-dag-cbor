import cbor from 'borc'
import isCircular from '@ipld/is-circular'

// https://github.com/ipfs/go-ipfs/issues/3570#issuecomment-273931692
const CID_CBOR_TAG = 42

const code = 0x71
const name = 'dag-cbor'

const create = multiformats => {
  const { CID, bytes, varint } = multiformats
  function tagCID (cid) {
    const buffer = Uint8Array.from([...bytes.fromHex('00'), ...cid.bytes])
    return new cbor.Tagged(CID_CBOR_TAG, buffer)
  }

  function replaceCIDbyTAG (dagNode) {
    if (dagNode && typeof dagNode === 'object' && isCircular(CID, dagNode)) {
      throw new Error('The object passed has circular references')
    }

    function transform (obj) {
      if (bytes.isBinary(obj)) return bytes.coerce(obj)
      if (!obj || typeof obj === 'string') {
        return obj
      }

      if (Array.isArray(obj)) {
        return obj.map(transform)
      }

      const cid = CID.asCID(obj)
      if (cid) {
        return tagCID(cid)
      }

      const keys = Object.keys(obj)

      if (keys.length > 0) {
        // Recursive transform
        const out = {}
        keys.forEach((key) => {
          if (typeof obj[key] === 'object') {
            out[key] = transform(obj[key])
          } else {
            out[key] = obj[key]
          }
        })
        return out
      } else {
        return obj
      }
    }

    return transform(dagNode)
  }

  const defaultTags = {
    [CID_CBOR_TAG]: (val) => {
      // remove that 0
      val = Uint8Array.from(val.slice(1))
      const [version] = varint.decode(val)
      if (version > 1) {
        // CIDv0
        return CID.create(0, 0x70, val)
      }
      return CID.from(val)
    }
  }
  const defaultSize = 64 * 1024 // current decoder heap size, 64 Kb
  let currentSize = defaultSize
  const defaultMaxSize = 64 * 1024 * 1024 // max heap size when auto-growing, 64 Mb
  let maxSize = defaultMaxSize
  let decoder = null

  /**
   * Configure the underlying CBOR decoder.
   *
   * @param {Object} [options] - The options the decoder takes. The decoder will reset to the defaul values if no options are given.
   * @param {number} [options.size=65536] - The current heap size used in CBOR parsing, this may grow automatically as larger blocks are encountered up to `maxSize`
   * @param {number} [options.maxSize=67108864] - The maximum size the CBOR parsing heap is allowed to grow to before `dagCBOR.util.deserialize()` returns an error
   * @param {Object} [options.tags] - An object whose keys are CBOR tag numbers and values are transform functions that accept a `value` and return a decoded representation of that `value`
   */
  const configureDecoder = (options) => {
    const tags = defaultTags

    if (options) {
      if (typeof options.size === 'number') {
        currentSize = options.size
      }
      if (typeof options.maxSize === 'number') {
        maxSize = options.maxSize
      }
    } else {
      // no options, reset to defaults
      currentSize = defaultSize
      maxSize = defaultMaxSize
    }

    const decoderOptions = {
      tags,
      size: currentSize
    }

    decoder = new cbor.Decoder(decoderOptions)
    // borc edits opts.size in-place so we can capture _actual_ size
    currentSize = decoderOptions.size
  }
  configureDecoder()
  create.configureDecoder = configureDecoder // for testing

  const encode = (node) => {
    const nodeTagged = replaceCIDbyTAG(node)
    const serialized = cbor.encode(nodeTagged)
    return bytes.coerce(serialized)
  }

  const decode = (data) => {
    if (data.length > currentSize && data.length <= maxSize) {
      configureDecoder({ size: data.length })
    }

    if (data.length > currentSize) {
      throw new Error('Data is too large to deserialize with current decoder')
    }

    // borc will decode back-to-back objects into an implicit top-level array, we
    // strictly want to only see a single explicit top-level object
    const all = decoder.decodeAll(data)
    if (all.length !== 1) {
      throw new Error('Extraneous CBOR data found beyond initial top-level object')
    }
    return all[0]
  }

  return { encode, decode, code, name }
}
export default create
