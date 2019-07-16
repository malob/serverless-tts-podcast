import { createHash } from 'crypto'
import { array } from 'fp-ts/lib/Array'
import { taskEither } from 'fp-ts/lib/TaskEither'
import { Config } from './types'
import * as config from '../config.json'

export const conf = config as Config
export const base64Decode = (s: string): string => Buffer.from(s, 'base64').toString()
export const stringToHash = (s: string): string => createHash('md5').update(s).digest('hex')
export const traverseArrayTE = array.traverse(taskEither)
export const traverseArrayWithIndexTE = array.traverseWithIndex(taskEither)
