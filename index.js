const { Transformer } = require('@parcel/plugin')
const parser = require('posthtml-parser').default
const nullthrows = require('nullthrows')
const { render } = require('posthtml-render')
const semver = require('semver')
const PostHTML = require('posthtml')
const R = require('ramda')

module.exports = new Transformer({
  async loadConfig({ config }) {
    const { contents } = (await config.getConfig(['html-datasrc.config.json'])) || {}
    return contents
  },

  canReuseAST({ ast }) {
    return ast.type === 'posthtml' && semver.satisfies(ast.version, '^0.4.0')
  },

  async parse({ asset }) {
    return {
      type: 'posthtml',
      version: '0.4.1',
      program: parser(await asset.getCode(), {
        lowerCaseAttributeNames: true,
      }),
    }
  },

  async transform({ config, asset }) {
    // must add logger to transform like ({ config, asset, logger}) if compile console.logs are desired
    // logger.warn({ message: ` log message: ${config}` })

    const ast = nullthrows(await asset.getAST())
    let isDirty
    PostHTML().walk.call(ast.program, node => {
      const { tag, attrs } = node
      if (!attrs) {
        return node
      }
      // Default supported element and attribute pairs
      // Must be arrays
      const elemAndAttributes = {
        div: [
          'data-bg',
          'data-background-image',
          'data-bg-hidpi',
          'data-bg-multi',
          'data-background-image-set',
          'data-bg-multi-hidpi',
        ],
        iframe: ['data-src'],
        img: ['data-srcset', 'data-src', 'data-bp'],
        picture: ['data-iesrc'],
        source: ['data-src', 'data-srcset', 'srcset'],
        video: ['data-src', 'data-poster'],
      }

      // Optional user config file
      const customElemAndAttrsConfig = config || undefined

      const mergedConfigs = customElemAndAttrsConfig
        ? R.mergeWith(R.concat, elemAndAttributes, customElemAndAttrsConfig)
        : elemAndAttributes

      const currentTagAttrs = R.length(mergedConfigs[tag]) > 1 ? [...new Set(mergedConfigs[tag])] : mergedConfigs[tag]

      const areMultipleFilteredValues = currentTagAttrs ? /,/.test(currentTagAttrs) : undefined

      const regexInsideParen = /(?<=url\().*(?=\))/
      const regexQuoteInsideParen = /(?<=url\(['|"]).*(?=['|"]\))/

      /*
       *  Adds url dependency to attributes such as:
       *
       *   <img data-src="lazy-head.jpg" >...</img>
       *   <img data-srcset="lazy_400.jpg 400w, lazy_800.jpg 800w" >...</img>
       *
       */

      const addBasicUrlDependency = item => {
        const srcsets = attrs[item].split(',').map(el => {
          const [url, width] = el.trim().split(' ')
          return width && url ? `${asset.addURLDependency(url)} ${width}` : asset.addURLDependency(url)
        })
        attrs[item] = srcsets.join(', ')
        isDirty = true
      }

      /*
       *  Adds url dependency to attributes such as data-bg-multi that contain
       *  both multiple url() wrapped sources and other data
       *
       *   <div data-bg-multi="url(lazy-head.jpg), url(lazy-body.jpg), linear-gradient(#fff, #ccc)" >...</div>
       *
       */

      const addUrlAndGradientAttrsDependency = item => {
        const srcsets = attrs[item]
          .trim()
          .split(',')
          .map(el => {
            if (regexQuoteInsideParen.test(el)) {
              const url = el.match(regexQuoteInsideParen)
              const updatedUrl = asset.addURLDependency(url, {})
              return el.replace(regexQuoteInsideParen, updatedUrl)
            }
            if (regexInsideParen.test(el)) {
              const url = el.match(regexInsideParen)
              const updatedUrl = asset.addURLDependency(url, {})
              return el.replace(regexInsideParen, updatedUrl)
            }
            return el.trim()
          })
          .join(', ')
        attrs[item] = srcsets
        isDirty = true
      }

      if (areMultipleFilteredValues) {
        // eslint-disable-next-line no-restricted-syntax
        for (const item of currentTagAttrs) {
          const isRegexUrl = regexInsideParen.test(attrs[item]) || regexQuoteInsideParen.test(attrs[item]) || undefined
          if (attrs[item] != null && isRegexUrl) {
            addUrlAndGradientAttrsDependency(item)
          } else if (attrs[item] != null) {
            addBasicUrlDependency(item)
          }
        }
      }

      if (!areMultipleFilteredValues) {
        const isRegexUrl =
          regexInsideParen.test(attrs[currentTagAttrs]) ||
          regexQuoteInsideParen.test(attrs[currentTagAttrs]) ||
          undefined
        if (attrs[currentTagAttrs] != null && isRegexUrl) {
          addUrlAndGradientAttrsDependency(currentTagAttrs)
        } else if (attrs[currentTagAttrs] != null) {
          addBasicUrlDependency(currentTagAttrs)
        }
      }

      return node
    })

    if (isDirty) {
      asset.setAST(ast)
    }
    return [asset]
  },

  generate({ ast }) {
    return {
      content: render(ast.program),
    }
  },
})
