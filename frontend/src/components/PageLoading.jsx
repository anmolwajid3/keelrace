export default function PageLoading({ lines = 4 }) {
  return (
    <div className="page-loading" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{ height: i === 0 ? 22 : 14, width: i % 3 === 0 ? '42%' : '100%', marginBottom: 10 }}
        />
      ))}
    </div>
  )
}
