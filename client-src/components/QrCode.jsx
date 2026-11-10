import qrcode from 'qrcode-generator'

export function QrCode({ value, size = 180 }) {
  const src = React.useMemo(() => {
    if (!value) return ''
    try {
      const qr = qrcode(0, 'M')
      qr.addData(value)
      qr.make()
      return qr.createDataURL(4, 8)
    } catch {
      return ''
    }
  }, [value])
  if (!src) return null
  return <img className="mc-qr" src={src} width={size} height={size} alt="QR" />
}
