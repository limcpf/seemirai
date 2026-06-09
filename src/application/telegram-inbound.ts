/**
 * Telegram inbound command application public entry다.
 *
 * 세부 구현은 같은 이름의 `telegram-inbound/` 디렉터리에 두어 parser, 보안 allowlist, dedupe, audit contract를
 * transport와 분리한다. 이 entry는 Telegram provider 호출이나 DB write side effect를 직접 수행하지 않는다.
 */
export * from "./telegram-inbound/index.js";
