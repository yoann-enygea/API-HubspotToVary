/* 
  Fetch request with type setup  
  To use this function you can call it like this
  const data = await request<YourType>(`books/${id}`);
*/

export const request = async <TResponse>(
  url: string,
  config?: RequestInit
): Promise<TResponse> => {
  const response = await fetch(`${process.env.baseUrl}${url}`, {
    method: "GET",
    // headers: {
    //   "X-Auth-Token": process.env.auth_token,
    //   "X-Organization-Id": process.env.organization_id,
    //   "Content-Type": "application/json",
    // },
    ...config,
  });
  return await response.json();
};
