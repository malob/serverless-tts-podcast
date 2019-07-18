import { createHash } from 'crypto'
import { constVoid } from 'fp-ts/lib/function'
import { pipe } from 'fp-ts/lib/pipeable'
import { array } from 'fp-ts/lib/Array'
import { error } from 'fp-ts/lib/Console'
import { Either, fold } from 'fp-ts/lib/Either'
import { taskEither } from 'fp-ts/lib/TaskEither'
import { Config, Err, ErrConstructor } from './types'

export const conf: Config = require('../config')()
export const base64Decode = (s: string): string => Buffer.from(s, 'base64').toString()
export const mkErrConstructor = (m: string): ErrConstructor => () => { return {message: m} }
export const handleEither = (x: Either<Err, unknown>): void => pipe(x, fold(e => error(e.message)(), constVoid))
export const stringToHash = (s: string): string => createHash('md5').update(s).digest('hex')
export const traverseArrayTE = array.traverse(taskEither)
export const traverseArrayWithIndexTE = array.traverseWithIndex(taskEither)
